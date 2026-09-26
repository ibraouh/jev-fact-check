import { checkPasscode } from "@/lib/auth";

export async function POST(request: Request) {
  return checkPasscode(request) ?? Response.json({ ok: true });
}
