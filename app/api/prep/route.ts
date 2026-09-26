import { checkPasscode } from "@/lib/auth";
import { buildEvidencePack } from "@/lib/claude";

// Claude searches the web and reads sources, which takes a minute or two.
export const maxDuration = 300;

export async function POST(request: Request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const { topic, sides } = (await request.json()) as { topic?: string; sides?: string };
  if (!topic?.trim()) return Response.json({ error: "Enter a debate topic first" }, { status: 400 });

  try {
    const pack = await buildEvidencePack(topic.trim(), sides?.trim() ?? "");
    return Response.json(pack, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
