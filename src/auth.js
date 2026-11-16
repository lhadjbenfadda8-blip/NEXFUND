import { json } from "./http.js";

export async function readSession(request, db) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)nexfund_session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const row = await db.prepare(
    "SELECT s.id AS session_id,u.id AS user_id,u.email,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?"
  ).bind(hash).first();
  if (!row || row.status !== "active" || row.expires_at <= new Date().toISOString()) {
    if (row) await db.prepare("DELETE FROM sessions WHERE id=?").bind(row.session_id).run();
    return null;
  }
  await db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").bind(new Date().toISOString(), row.session_id).run();
  return row;
}
export function requireAdmin(session) {
  return session.role === "admin" ? null : json({ error: "Administrator access required." }, 403);
}
export function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return json({ error: "Cross-origin request rejected." }, 403);
  } catch { return json({ error: "Invalid request origin." }, 403); }
  return null;
}
