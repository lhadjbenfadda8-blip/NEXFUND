import { readSession, requireAdmin, requireSameOrigin } from "./auth.js";
import { json } from "./http.js";
import { evaluateChallenge } from "./risk-engine.js";

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    // Serve website and trader portal from Workers Static Assets.
    if (!url.pathname.startsWith("/api/")) {
      if (!env.ASSETS) return json({ error: "Static assets binding ASSETS is not configured" }, 503);
      return env.ASSETS.fetch(request);
    }
    if (!env.DB) return json({ error: "Database binding DB is not configured" }, 503);

    try {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        const originError = requireSameOrigin(request);
        if (originError) return originError;
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1").first();
        return json({ ok: true, service: "nexfund-api", database: "connected", mode: "cloudflare-worker" });
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
        if (password.length < 12 || password.length > 128) return json({ error: "Password must be 12–128 characters." }, 400);
        const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existing) return json({ error: "An account with this email already exists." }, 409);
        const { salt, hash } = await hashPassword(password);
        const userId = id();
        await env.DB.prepare("INSERT INTO users (id,email,password_hash,password_salt,role,status) VALUES (?,?,?,?,'trader','active')")
          .bind(userId, email, hash, salt).run();
        const session = await createSession(env.DB, userId);
        return json({ user: { id: userId, email, role: "trader" } }, 201, { "Set-Cookie": session.cookie });
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const user = await env.DB.prepare("SELECT id,email,password_hash,password_salt,role,status FROM users WHERE email = ?").bind(email).first();
        if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
          return json({ error: "Email or password is incorrect." }, 401);
        }
        const session = await createSession(env.DB, user.id);
        return json({ user: { id: user.id, email: user.email, role: user.role } }, 200, { "Set-Cookie": session.cookie });
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const session = await readSession(request, env.DB);
        if (session) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.session_id).run();
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
      }

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const session = await readSession(request, env.DB);
        return session ? json({ user: { id: session.user_id, email: session.email, role: session.role } }) : json({ user: null }, 401);
      }

      const session = await readSession(request, env.DB);
      if (!session) return json({ error: "Authentication required." }, 401);

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        const challenges = await env.DB.prepare(
          "SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.started_at,c.created_at,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id WHERE c.user_id=? ORDER BY c.created_at DESC"
        ).bind(session.user_id).all();
        const notifications = await env.DB.prepare("SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20").bind(session.user_id).all();
        return json({ challenges: challenges.results, notifications: notifications.results });
      }

      if (url.pathname === "/api/challenges" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT c.*,p.name AS program_name FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id WHERE c.user_id=? ORDER BY c.created_at DESC")
          .bind(session.user_id).all();
        return json({ challenges: rows.results });
      }

      if (url.pathname === "/api/admin/overview" && request.method === "GET") {
        const denied = requireAdmin(session);
        if (denied) return denied;
        const [users, challenges, pendingOrders] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(),
          env.DB.prepare("SELECT status,COUNT(*) AS count FROM challenges GROUP BY status").all(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='pending'").first()
        ]);
        return json({ users: users.count, challenges: challenges.results, pending_orders: pendingOrders.count });
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        const denied = requireAdmin(session);
        if (denied) return denied;
        const rows = await env.DB.prepare("SELECT id,email,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 100").all();
        return json({ users: rows.results });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("NEXFUND API error", error);
      return json({ error: "Internal server error." }, 500);
    }
  }
};

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toBase64(saltBytes);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 310000, hash: "SHA-256" }, key, 256);
  return { salt, hash: toBase64(new Uint8Array(bits)) };
}
async function verifyPassword(password, salt, expected) {
  if (typeof password !== "string" || typeof salt !== "string" || typeof expected !== "string") return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromBase64(salt), iterations: 310000, hash: "SHA-256" }, key, 256);
  return constantTimeEqual(toBase64(new Uint8Array(bits)), expected);
}
async function createSession(db, userId) {
  const raw = randomToken();
  const tokenHash = await sha256(raw);
  const sessionId = id();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(sessionId, userId, tokenHash, expires).run();
  return { cookie: `nexfund_session=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` };
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function sha256(value) {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function toBase64(bytes) { let s=""; for (const b of bytes) s+=String.fromCharCode(b); return btoa(s); }
function fromBase64(value) { const s=atob(value); return Uint8Array.from(s,c=>c.charCodeAt(0)); }
function constantTimeEqual(a,b) {
  if (a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function clearCookie() { return "nexfund_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"; }
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" } : {};
}
