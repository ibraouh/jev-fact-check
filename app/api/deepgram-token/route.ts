import { checkPasscode } from "@/lib/auth";

// The browser streams audio straight to Deepgram (Vercel functions can't hold a
// WebSocket open), so it needs a short-lived token instead of the real key.
export async function POST(request: Request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return Response.json({ error: "DEEPGRAM_API_KEY is not configured" }, { status: 500 });

  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    // The token only has to be valid when the socket opens; the stream outlives it.
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!res.ok) {
    return Response.json({ error: `Deepgram token request failed (${res.status})` }, { status: 502 });
  }
  const { access_token } = (await res.json()) as { access_token: string };
  return Response.json({ token: access_token }, { headers: { "Cache-Control": "no-store" } });
}
