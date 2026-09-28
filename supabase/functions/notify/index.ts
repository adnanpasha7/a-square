// Supabase Edge Function with two jobs:
//  1. Called by a Database Webhook on INSERT into public.messages: sends a Web Push
//     notification to every device of the *other* person.
//  2. Called from the app's "Send test notification" button (signed-in user's JWT):
//     sends a test push to the caller's own devices and reports exactly what failed.
//
// Deploy:  supabase functions deploy notify --no-verify-jwt
// Secrets: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//            VAPID_SUBJECT=mailto:you@example.com WEBHOOK_SECRET=some-long-random-string

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // auto-injected; bypasses RLS
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type MessageRow = {
  id: string;
  sender_id: string;
  body: string | null;
  image_path: string | null;
};

type Sub = { endpoint: string; p256dh: string; auth: string };
type PushError = { statusCode?: number; body?: string; message?: string };

// Returns a problem description, or null when VAPID is ready to use
function setupVapid(): string | null {
  const missing = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "WEBHOOK_SECRET"].filter(
    (k) => !Deno.env.get(k),
  );
  if (missing.length) return `Missing Supabase secrets: ${missing.join(", ")}.`;
  try {
    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT")!,
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!,
    );
    return null;
  } catch (e) {
    return `VAPID secrets are invalid: ${(e as Error).message}`;
  }
}

function send(s: Sub, payload: string) {
  return webpush.sendNotification(
    { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
    payload,
    { TTL: 60 * 60 * 24, urgency: "high" },
  );
}

// 404/410 = subscription is dead (app uninstalled, permission revoked)
async function dropIfDead(s: Sub, err: PushError) {
  if (err.statusCode === 404 || err.statusCode === 410) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    return true;
  }
  return false;
}

function explain(err: PushError): string {
  const detail = `${err.statusCode ?? ""} ${err.body ?? err.message ?? ""}`.trim();
  if (err.statusCode === 404 || err.statusCode === 410) {
    return "This device's subscription has expired. Turn notifications off and on again.";
  }
  if (err.statusCode === 403 || /BadJwtToken|VAPID|credentials/i.test(detail)) {
    return `The push service rejected the VAPID keys (${detail}). Check the private key belongs to the public key, and that VAPID_SUBJECT is a real "mailto:you@yourdomain" or https URL (Apple rejects example.com and localhost).`;
  }
  return `The push service refused the notification: ${detail}`;
}

async function handleTest(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /i, "");
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth.user) {
    console.error("Rejected a call with no x-webhook-secret and no signed-in user. If this is the Database Webhook, add the x-webhook-secret header to it.");
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const problem = setupVapid();
  if (problem) return json({ ok: false, error: problem });

  const { publicKey } = await req.json().catch(() => ({}));
  if (publicKey && publicKey !== Deno.env.get("VAPID_PUBLIC_KEY")) {
    return json({
      ok: false,
      error:
        "The app's NEXT_PUBLIC_VAPID_PUBLIC_KEY doesn't match the VAPID_PUBLIC_KEY secret in Supabase. Make them the same, redeploy, then turn notifications off and on again.",
    });
  }

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", auth.user.id);
  if (error) return json({ ok: false, error: `Database error: ${error.message}` });
  if (!subs?.length) {
    return json({ ok: false, error: "No devices are signed up for you. Turn notifications off and on again." });
  }

  const payload = JSON.stringify({
    title: "A ♥ A",
    body: "Test notification. If you can see this, notifications work on this phone ♥",
    url: "/",
    tag: "us-test",
  });
  // Give them a moment to leave the app, since some phones hide notifications for the app that's open
  await new Promise((r) => setTimeout(r, 5000));

  const failures: string[] = [];
  let sent = 0;
  for (const s of subs as Sub[]) {
    try {
      await send(s, payload);
      sent++;
    } catch (e) {
      await dropIfDead(s, e as PushError);
      failures.push(explain(e as PushError));
    }
  }
  return json({ ok: sent > 0, sent, devices: subs.length, error: failures[0] ?? null });
}

async function handleWebhook(req: Request) {
  const payload = await req.json();
  if (payload.type !== "INSERT" || payload.table !== "messages") {
    return new Response("ignored");
  }
  const msg = payload.record as MessageRow;

  const problem = setupVapid();
  if (problem) {
    console.error(problem);
    return new Response(problem, { status: 500 });
  }

  const [{ data: sender }, { data: subs, error }] = await Promise.all([
    supabase.from("members").select("display_name").eq("user_id", msg.sender_id).single(),
    supabase.from("push_subscriptions").select("*").neq("user_id", msg.sender_id),
  ]);
  if (error) {
    console.error(error);
    return new Response("db error", { status: 500 });
  }
  if (!subs?.length) console.warn("No push subscriptions for the recipient");

  const notification = JSON.stringify({
    title: sender?.display_name ?? "New message",
    body: msg.body?.trim() ? msg.body.slice(0, 140) : "Sent you a photo ♥",
    url: "/",
    tag: "us-message",
  });

  const results = await Promise.allSettled(
    (subs ?? []).map((s: Sub) =>
      send(s, notification).catch(async (err: PushError) => {
        if (!(await dropIfDead(s, err))) throw new Error(explain(err));
      }),
    ),
  );

  results.forEach((r) => r.status === "rejected" && console.error(r.reason));
  return new Response("ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // --no-verify-jwt means anyone could hit this URL: the webhook proves itself with a
  // shared secret, and the test button with the signed-in user's JWT.
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== null) {
    if (secret !== Deno.env.get("WEBHOOK_SECRET")) {
      console.error("Webhook called with the wrong x-webhook-secret");
      return new Response("unauthorized", { status: 401 });
    }
    return handleWebhook(req);
  }
  return handleTest(req);
});
