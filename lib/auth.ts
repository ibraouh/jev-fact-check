import { timingSafeEqual } from "node:crypto";

/**
 * The app calls paid APIs, so every route requires the shared passcode from
 * APP_PASSCODE. Without it anyone who finds the URL could spend your credits.
 */
export function checkPasscode(request: Request): Response | null {
  const expected = process.env.APP_PASSCODE;
  if (!expected) {
    return Response.json({ error: "APP_PASSCODE is not configured on the server" }, { status: 500 });
  }
  const given = request.headers.get("x-app-passcode") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "Wrong passcode" }, { status: 401 });
  }
  return null;
}
