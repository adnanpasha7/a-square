// Supabase Edge Function: called by a Database Webhook on INSERT into public.messages.
// Sends a Web Push notification to every device of the *other* person.
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

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

type MessageRow = {
  id: string;
  sender_id: string;
  body: string | null;
  image_path: string | null;
};

Deno.serve(async (req) => {
  // --no-verify-jwt means anyone could hit this URL, so check a shared secret
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const payload = await req.json();
  if (payload.type !== "INSERT" || payload.table !== "messages") {
    return new Response("ignored");
  }
  const msg = payload.record as MessageRow;

  const [{ data: sender }, { data: subs, error }] = await Promise.all([
    supabase.from("members").select("display_name").eq("user_id", msg.sender_id).single(),
    supabase.from("push_subscriptions").select("*").neq("user_id", msg.sender_id),
  ]);
  if (error) {
    console.error(error);
    return new Response("db error", { status: 500 });
  }

  const notification = JSON.stringify({
    title: sender?.display_name ?? "New message",
    body: msg.body?.trim() ? msg.body.slice(0, 140) : "Sent you a photo ♥",
    url: "/",
    tag: "us-message",
  });

  const results = await Promise.allSettled(
    (subs ?? []).map((s) =>
      webpush
        .sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notification,
          { TTL: 60 * 60 * 24, urgency: "high" },
        )
        .catch(async (err: { statusCode?: number }) => {
          // 404/410 = subscription is dead (app uninstalled, permission revoked)
          if (err.statusCode === 404 || err.statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          } else {
            throw err;
          }
        }),
    ),
  );

  results.forEach((r) => r.status === "rejected" && console.error(r.reason));
  return new Response("ok");
});
