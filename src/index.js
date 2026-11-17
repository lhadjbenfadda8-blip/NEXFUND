import { readSession, requireAdmin, requireSameOrigin } from "./auth.js";
import { json } from "./http.js";
import { evaluateChallenge } from "./risk-engine.js";

const now = () => new Date().toISOString();
const DEFAULT_PROGRAMS = [
  ["nexfund-eval-2000-v1", 2000, 25],
  ["nexfund-eval-5000-v1", 5000, 49],
  ["nexfund-eval-10000-v1", 10000, 89],
  ["nexfund-eval-25000-v1", 25000, 189],
  ["nexfund-eval-50000-v1", 50000, 289],
  ["nexfund-eval-100000-v1", 100000, 499],
  ["nexfund-eval-200000-v1", 200000, 899]
];
async function ensureDefaultPrograms(db) {
  const statements = DEFAULT_PROGRAMS.map(([programId, size, fee]) =>
    db.prepare("INSERT OR IGNORE INTO evaluation_programs (id,name,description,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,status,rules_json) VALUES (?,?,?,?,?,8,5,10,5,'active',?)")
      .bind(programId, `NEXFUND ${size.toLocaleString("en-US")} USD Evaluation`, "Single-phase evaluation proposal. MT5 demo integration only; terms and fee are provisional and configurable.", size, fee, JSON.stringify({ phase: "one_step", platform: "MT5", daily_loss_basis: "daily_start_equity", max_loss_basis: "initial_balance", fee_is_provisional: true }))
  );
  await db.batch(statements);
}

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


      if (url.pathname === "/api/programs" && request.method === "GET") {
        await ensureDefaultPrograms(env.DB);
        const rows = await env.DB.prepare("SELECT id,name,description,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,max_trading_days FROM evaluation_programs WHERE status='active' ORDER BY account_size_usd ASC").all();
        return json({ programs: rows.results, pricing_status: "provisional" });
      }

      if (url.pathname === "/api/challenges" && request.method === "POST") {
        const body = await request.json();
        const programId = String(body.program_id || "");
        const platform = String(body.platform || "");
        if (platform !== "MT5") return json({ error: "Currently only MetaTrader 5 (MT5) is supported." }, 400);
        await ensureDefaultPrograms(env.DB);
        const program = await env.DB.prepare("SELECT id,account_size_usd,fee_usd FROM evaluation_programs WHERE id=? AND status='active'").bind(programId).first();
        if (!program) return json({ error: "The selected evaluation program is unavailable." }, 404);
        const challengeId = id();
        const balance = Number(program.account_size_usd);
        const today = new Date().toISOString().slice(0,10);
        const paymentId = id();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO challenges (id,user_id,program_id,status,initial_balance,current_balance,equity,high_watermark,daily_start_equity,daily_start_date) VALUES (?,?,?,'pending',?,?,?,?,?,?)")
            .bind(challengeId, session.user_id, program.id, balance, balance, balance, balance, balance, today),
          env.DB.prepare("INSERT INTO trading_accounts (id,challenge_id,platform,integration_mode,connection_status) VALUES (?,?,?,'demo','not_connected')")
            .bind(id(), challengeId, platform),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'challenge',?,?)")
            .bind(id(), session.user_id, "challenge.selection_created", challengeId, JSON.stringify({ platform, program_id: program.id })),
          env.DB.prepare("INSERT INTO crypto_payments (id,challenge_id,user_id,amount_usdt,status) VALUES (?,?,?,? ,'pending')")
            .bind(paymentId, challengeId, session.user_id, Number(program.fee_usd))
        ]);
        return json({ ok: true, challenge_id: challengeId, payment_id: paymentId, status: "pending", platform, message: "Selection saved. Complete USDT TRC20 payment to activate the evaluation." }, 201);
      }

      if (url.pathname.startsWith("/api/payments/") && request.method === "GET") {
        const paymentId = url.pathname.split("/")[3];
        const payment = await env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid,created_at,paid_at FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!payment) return json({ error: "Payment request not found." }, 404);
        if (!env.USDT_TRC20_ADDRESS) return json({ error: "USDT TRC20 receiving address is not configured yet." }, 503);
        return json({ payment, network: "TRON (TRC20)", token: "USDT", receiving_address: env.USDT_TRC20_ADDRESS, payment_enabled: env.PAYMENTS_ENABLED === "true" });
      }

      if (url.pathname.startsWith("/api/payments/") && url.pathname.endsWith("/verify") && request.method === "POST") {
        if (env.PAYMENTS_ENABLED !== "true") return json({ error: "Crypto payments are not enabled yet." }, 503);
        if (!env.USDT_TRC20_ADDRESS) return json({ error: "Receiving address is not configured." }, 503);
        const paymentId = url.pathname.split("/")[3];
        const body = await request.json();
        const txid = String(body.txid || "").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) return json({ error: "Enter a valid 64-character TRON transaction ID." }, 400);
        const payment = await env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!payment) return json({ error: "Payment request not found." }, 404);
        if (payment.status === "paid") return json({ ok: true, status: "paid", message: "Payment was already confirmed." });
        const used = await env.DB.prepare("SELECT id FROM crypto_payments WHERE txid=? AND status='paid'").bind(txid).first();
        if (used) return json({ error: "This transaction has already been used." }, 409);

        const apiUrl = "https://api.trongrid.io/v1/accounts/" + encodeURIComponent(env.USDT_TRC20_ADDRESS) +
          "/transactions/trc20?only_confirmed=true&limit=200&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        const headers = {};
        if (env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = env.TRONGRID_API_KEY;
        const chainResponse = await fetch(apiUrl, { headers });
        if (!chainResponse.ok) return json({ error: "Could not verify the transaction with TRON right now. Try again later." }, 502);
        const chainData = await chainResponse.json();
        const transfer = (chainData.data || []).find(item =>
          String(item.transaction_id || "").toLowerCase() === txid &&
          String(item.to || "").toLowerCase() === String(env.USDT_TRC20_ADDRESS).toLowerCase() &&
          String(item.token_info?.address || "").toLowerCase() === "tr7nhqjekqxgtci8q8zy4p8lotszgjlj6t" &&
          String(item.type || "").toLowerCase() === "transfer"
        );
        if (!transfer) return json({ error: "No confirmed incoming USDT TRC20 transfer matching this transaction was found. Check the network, recipient and confirmation status." }, 400);
        const receivedMicros = BigInt(String(transfer.value || "0"));
        const expectedMicros = BigInt(Math.round(Number(payment.amount_usdt) * 1_000_000));
        if (receivedMicros !== expectedMicros) return json({ error: "The confirmed transfer amount does not match the requested amount." }, 400);
        if (payment.txid && payment.txid !== txid) return json({ error: "A different transaction ID is already attached to this payment." }, 409);

        await env.DB.batch([
          env.DB.prepare("UPDATE crypto_payments SET txid=?,status='paid',paid_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending'").bind(txid, paymentId),
          env.DB.prepare("UPDATE challenges SET status='active',started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND user_id=? AND status='pending'").bind(payment.challenge_id, session.user_id),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'crypto_payment',?,?)")
            .bind(id(), session.user_id, "crypto_payment.confirmed", paymentId, JSON.stringify({ txid, amount_usdt: payment.amount_usdt, network: "TRC20" }))
        ]);
        return json({ ok: true, status: "paid", challenge_status: "active", message: "Confirmed USDT payment. Your evaluation is now active." });
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        const challenges = await env.DB.prepare(
          "SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.started_at,c.created_at,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,t.platform,t.connection_status FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE c.user_id=? ORDER BY c.created_at DESC"
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
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, key, 256);
  return { salt, hash: toBase64(new Uint8Array(bits)) };
}
async function verifyPassword(password, salt, expected) {
  if (typeof password !== "string" || typeof salt !== "string" || typeof expected !== "string") return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromBase64(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
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
