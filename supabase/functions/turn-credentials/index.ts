// Supabase Edge Function: mints short-lived TURN credentials for the live view.
// Called from the app with the signed-in user's JWT; only members get credentials.
//
// Deploy:  npx supabase functions deploy turn-credentials      (JWT verification stays ON)
// Secrets: npx supabase secrets set CF_TURN_KEY_ID=... CF_TURN_API_TOKEN=...

// No imports on purpose: nothing has to be downloaded when the function is bundled.

const TTL_SECONDS = 60 * 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type IceServer = { urls: string | string[]; username?: string; credential?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Run is_member() as the caller (their JWT), so auth.uid() is theirs
  const check = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/is_member`, {
    method: "POST",
    headers: {
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: req.headers.get("Authorization") ?? "",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!check.ok || (await check.json()) !== true) return json({ error: "forbidden" }, 403);

  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const token = Deno.env.get("CF_TURN_API_TOKEN");
  if (!keyId || !token) return json({ error: "TURN is not configured" }, 500);

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!res.ok) {
    console.error("Cloudflare TURN error", res.status, await res.text());
    return json({ error: "couldn't mint TURN credentials" }, 502);
  }

  const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
  const raw = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
  // Browsers refuse port 53, so drop those URLs (Cloudflare's docs recommend this)
  const iceServers = raw
    .map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);

  return json({ iceServers, ttl: TTL_SECONDS });
});
