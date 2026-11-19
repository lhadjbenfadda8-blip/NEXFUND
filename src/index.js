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

async function ensureMT5DeliveryTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS mt5_account_deliveries (
    id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, encrypted_password TEXT NOT NULL, encryption_iv TEXT NOT NULL,
    email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','failed')),
    provider_account_ref TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), emailed_at TEXT, last_error TEXT
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_mt5_delivery_user ON mt5_account_deliveries(user_id,created_at)').run();
}
async function ensureCryptoPayments(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS crypto_payments (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_usdt REAL NOT NULL CHECK (amount_usdt > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','rejected')),
    txid TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_crypto_payments_user ON crypto_payments(user_id,created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_crypto_payments_status ON crypto_payments(status)").run();
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
        await ensureCryptoPayments(env.DB);
        const body = await request.json();
        const programId = String(body.program_id || "");
        const platform = String(body.platform || "");
        if (platform !== "MT5") return json({ error: "Currently only MetaTrader 5 (MT5) is supported." }, 400);
        await ensureDefaultPrograms(env.DB);
        const program = await env.DB.prepare("SELECT id,account_size_usd,fee_usd FROM evaluation_programs WHERE id=? AND status='active'").bind(programId).first();
        if (!program) return json({ error: "The selected evaluation program is unavailable." }, 404);
        const existing = await env.DB.prepare(
          "SELECT c.id AS challenge_id,p.id AS payment_id,p.amount_usdt,p.status AS payment_status FROM challenges c JOIN crypto_payments p ON p.challenge_id=c.id WHERE c.user_id=? AND c.program_id=? AND c.status='pending' AND p.status='pending' ORDER BY c.created_at DESC LIMIT 1"
        ).bind(session.user_id, program.id).first();
        if (existing) {
          return json({ ok: true, challenge_id: existing.challenge_id, payment_id: existing.payment_id, status: "pending", platform, reused: true, message: "An existing pending request was found and reused." }, 200);
        }
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
        await ensureCryptoPayments(env.DB);
        const paymentId = url.pathname.split("/")[3];
        const payment = await env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid,created_at,paid_at FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!payment) return json({ error: "Payment request not found." }, 404);
        return json({ payment, network: "TRON (TRC20)", token: "USDT", receiving_address: env.USDT_TRC20_ADDRESS || null, configuration_ready: Boolean(env.USDT_TRC20_ADDRESS), payment_enabled: env.PAYMENTS_ENABLED === "true" });
      }

      if (url.pathname.startsWith("/api/payments/") && url.pathname.endsWith("/verify") && request.method === "POST") {
        await ensureCryptoPayments(env.DB);
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
          env.DB.prepare("UPDATE challenges SET updated_at=datetime('now') WHERE id=? AND user_id=? AND status='pending'").bind(payment.challenge_id, session.user_id),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'crypto_payment',?,?)")
            .bind(id(), session.user_id, "crypto_payment.confirmed", paymentId, JSON.stringify({ txid, amount_usdt: payment.amount_usdt, network: "TRC20" }))
        ]);
        return json({ ok: true, status: "paid", challenge_status: "pending", message: "Payment confirmed. Your challenge is awaiting account provisioning; it will become active only after the trading account is successfully created." });
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        const challenges = await env.DB.prepare(
          "SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.started_at,c.created_at,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,t.platform,t.connection_status,t.account_login,t.server_name FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE c.user_id=? ORDER BY c.created_at DESC"
        ).bind(session.user_id).all();
        const notifications = await env.DB.prepare("SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20").bind(session.user_id).all();
        return json({ challenges: challenges.results, notifications: notifications.results });
      }

      if (url.pathname === "/api/challenges" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT c.*,p.name AS program_name FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id WHERE c.user_id=? ORDER BY c.created_at DESC")
          .bind(session.user_id).all();
        return json({ challenges: rows.results });
      }

      if (url.pathname === "/api/admin/challenges/pending-provisioning" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureMT5DeliveryTable(env.DB);
        const rows = await env.DB.prepare(
          "SELECT c.id AS challenge_id,u.email,p.name AS program_name,p.account_size_usd,cp.amount_usdt,cp.paid_at,c.created_at,td.email_status,t.account_login,t.server_name FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id JOIN crypto_payments cp ON cp.challenge_id=c.id LEFT JOIN mt5_account_deliveries td ON td.challenge_id=c.id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE cp.status='paid' AND (td.id IS NULL OR td.email_status='failed') ORDER BY cp.paid_at ASC LIMIT 100"
        ).all();
        return json({ challenges: rows.results });
      }

      const provisionMatch = url.pathname.match(/^\/api\/admin\/challenges\/([a-f0-9-]+)\/provision$/i);
      if (provisionMatch && request.method === 'POST') {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureMT5DeliveryTable(env.DB);
        const challengeId = provisionMatch[1];
        const challenge = await env.DB.prepare("SELECT c.id,c.status,u.id AS user_id,u.email,p.account_size_usd FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id JOIN crypto_payments cp ON cp.challenge_id=c.id WHERE c.id=? AND cp.status='paid'").bind(challengeId).first();
        if (!challenge) return json({ error: 'Paid challenge not found.' }, 404);
        const oldDelivery = await env.DB.prepare('SELECT * FROM mt5_account_deliveries WHERE challenge_id=?').bind(challengeId).first();
        if (oldDelivery) {
          if (oldDelivery.email_status === 'sent') return json({ ok: true, provisioned: true, email_status: 'sent', message: 'Credentials email was already sent.' });
          const account = await env.DB.prepare('SELECT account_login,server_name FROM trading_accounts WHERE challenge_id=?').bind(challengeId).first();
          const mail = await sendMT5CredentialsEmail(env, challenge, account, oldDelivery);
          return json({ ok: mail.ok, provisioned: true, email_status: mail.ok ? 'sent' : 'failed' }, mail.ok ? 200 : 502);
        }
        const providerUrl = String(env.MT5_PROVIDER_API_URL || '');
        if (!providerUrl || !env.MT5_PROVIDER_API_KEY || !env.RESEND_API_KEY || !env.MT5_EMAIL_FROM || !env.CREDENTIALS_ENCRYPTION_KEY) return json({ error: 'Configure MT5_PROVIDER_API_URL, MT5_PROVIDER_API_KEY, RESEND_API_KEY, MT5_EMAIL_FROM and CREDENTIALS_ENCRYPTION_KEY as Worker runtime secrets/variables first. No account was created.' }, 503);
        let endpoint; try { endpoint = new URL(providerUrl); } catch { return json({ error: 'Invalid MT5 provider URL.' }, 503); }
        if (endpoint.protocol !== 'https:') return json({ error: 'MT5 provider endpoint must use HTTPS.' }, 503);
        let providerResponse;
        try { providerResponse = await fetch(endpoint.toString(), { method:'POST', headers:{ Authorization:'Bearer '+env.MT5_PROVIDER_API_KEY, 'Content-Type':'application/json', 'Idempotency-Key':challengeId }, body:JSON.stringify({ external_reference:challengeId, brand:'NEXFUND', server_name:'NEXFUND', platform:'MT5', account_type:'simulated', balance:Number(challenge.account_size_usd), currency:'USD', trader_email:challenge.email }) }); }
        catch { return json({ error:'Could not reach MT5 provider.' }, 502); }
        if (!providerResponse.ok) return json({ error:'MT5 provider rejected account provisioning.' }, 502);
        let result; try { result = await providerResponse.json(); } catch { return json({ error:'MT5 provider returned invalid JSON.' }, 502); }
        const login=String(result.login||''), server=String(result.server||'NEXFUND'), password=String(result.password||''), accountRef=String(result.account_ref||challengeId);
        if (!/^[0-9]{4,20}$/.test(login) || !password || password.length>128 || server.length>100) return json({ error:'Provider response must contain numeric login, server and password. Nothing was saved or emailed.' }, 502);
        let encrypted; try { encrypted=await encryptCredential(password,env.CREDENTIALS_ENCRYPTION_KEY); } catch { return json({ error:'Credential encryption key is invalid; no credentials were saved.' }, 503); }
        const deliveryId=id();
        await env.DB.batch([
          env.DB.prepare('UPDATE trading_accounts SET account_login=?,server_name=?,external_account_ref=? WHERE challenge_id=?').bind(login,server,accountRef,challengeId),
          env.DB.prepare("INSERT INTO mt5_account_deliveries (id,challenge_id,user_id,encrypted_password,encryption_iv,provider_account_ref,email_status) VALUES (?,?,?,?,?,?,'pending')").bind(deliveryId,challengeId,challenge.user_id,encrypted.ciphertext,encrypted.iv,accountRef),
          env.DB.prepare("UPDATE challenges SET status='active',started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND status='pending'").bind(challengeId),
          env.DB.prepare('INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,\'trading_account\',?,?)').bind(id(),session.user_id,'mt5_account.provisioned',challengeId,JSON.stringify({login,server,provider:endpoint.hostname}))
        ]);
        const delivery=await env.DB.prepare('SELECT * FROM mt5_account_deliveries WHERE challenge_id=?').bind(challengeId).first();
        const mail=await sendMT5CredentialsEmail(env,challenge,{account_login:login,server_name:server},delivery);
        return json({ok:mail.ok,provisioned:true,email_status:mail.ok?'sent':'failed',login,server,message:mail.ok?'MT5 account provisioned and credentials email sent.':'Account created, but email failed. Retry after fixing email configuration.'},mail.ok?201:502);
      }
      if (url.pathname === "/api/admin/programs" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureDefaultPrograms(env.DB);
        const rows = await env.DB.prepare("SELECT id,name,description,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,max_trading_days,status,rules_json,created_at,updated_at FROM evaluation_programs ORDER BY account_size_usd ASC").all();
        return json({ programs: rows.results });
      }

      const adminProgramMatch = url.pathname.match(/^\\/api\\/admin\\/programs\\/([a-zA-Z0-9_-]+)$/);
      if (adminProgramMatch && request.method === "PUT") {
        const denied = requireAdmin(session); if (denied) return denied;
        const programId = adminProgramMatch[1];
        const existing = await env.DB.prepare("SELECT * FROM evaluation_programs WHERE id=?").bind(programId).first();
        if (!existing) return json({ error: "Evaluation program not found." }, 404);
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
        const name = String(body.name ?? existing.name).trim();
        const description = String(body.description ?? existing.description ?? "").trim();
        const size = Number(body.account_size_usd ?? existing.account_size_usd);
        const fee = Number(body.fee_usd ?? existing.fee_usd);
        const target = Number(body.profit_target_pct ?? existing.profit_target_pct);
        const daily = Number(body.daily_drawdown_pct ?? existing.daily_drawdown_pct);
        const maximum = Number(body.max_drawdown_pct ?? existing.max_drawdown_pct);
        const minDays = Number(body.min_trading_days ?? existing.min_trading_days);
        const maxDays = body.max_trading_days === null || (body.max_trading_days === undefined && existing.max_trading_days === null) ? null : Number(body.max_trading_days ?? existing.max_trading_days);
        const status = String(body.status ?? existing.status);
        if (!name || name.length > 120 || description.length > 1000) return json({ error: "Name (1–120 characters) and description (maximum 1000 characters) are required." }, 400);
        if (![size,fee,target,daily,maximum,minDays].every(Number.isFinite) || size < 100 || size > 10000000 || fee < 0 || fee > 100000 || target <= 0 || target > 100 || daily <= 0 || daily > 50 || maximum <= 0 || maximum > 100 || minDays < 0 || minDays > 365 || !Number.isInteger(minDays) || (maxDays !== null && (!Number.isInteger(maxDays) || maxDays < minDays || maxDays > 365))) return json({ error: "Program values are outside allowed ranges." }, 400);
        if (!["draft","active","paused","archived"].includes(status)) return json({ error: "Invalid program status." }, 400);
        await env.DB.batch([
          env.DB.prepare("UPDATE evaluation_programs SET name=?,description=?,account_size_usd=?,fee_usd=?,profit_target_pct=?,daily_drawdown_pct=?,max_drawdown_pct=?,min_trading_days=?,max_trading_days=?,status=?,updated_at=datetime('now') WHERE id=?")
            .bind(name,description,size,fee,target,daily,maximum,minDays,maxDays,status,programId),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'evaluation_program',?,?)")
            .bind(id(),session.user_id,"admin.program_updated",programId,JSON.stringify({name,account_size_usd:size,fee_usd:fee,profit_target_pct:target,daily_drawdown_pct:daily,max_drawdown_pct:maximum,min_trading_days:minDays,max_trading_days:maxDays,status}))
        ]);
        return json({ ok:true, message:"Evaluation program updated." });
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

      const adminUserStatusMatch = url.pathname.match(/^\\/api\\/admin\\/users\\/([a-f0-9-]+)\\/status$/i);
      if (adminUserStatusMatch && request.method === "PATCH") {
        const denied = requireAdmin(session); if (denied) return denied;
        const userId = adminUserStatusMatch[1];
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
        const status = String(body.status || "");
        if (!["active","suspended"].includes(status)) return json({ error: "Status must be active or suspended." }, 400);
        if (userId === session.user_id && status === "suspended") return json({ error: "You cannot suspend your own administrator account." }, 400);
        const user = await env.DB.prepare("SELECT id,email,status,role FROM users WHERE id=?").bind(userId).first();
        if (!user) return json({ error: "User not found." }, 404);
        if (user.role === "admin" && status === "suspended") {
          const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").first();
          if (Number(admins.count) <= 1) return json({ error: "Cannot suspend the last active administrator." }, 409);
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET status=?,updated_at=datetime('now') WHERE id=?").bind(status,userId),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'user',?,?)").bind(id(),session.user_id,"admin.user_status_changed",userId,JSON.stringify({email:user.email,old_status:user.status,new_status:status}))
        ]);
        if (status === "suspended") await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
        return json({ ok:true, user:{id:user.id,email:user.email,status}, message: status === "suspended" ? "User suspended and sessions revoked." : "User reactivated." });
      }

      if (url.pathname === "/api/admin/financials" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureCryptoPayments(env.DB);
        const [orders, payments] = await Promise.all([
          env.DB.prepare("SELECT o.id,o.status,o.amount_usd,o.currency,o.payment_provider,o.provider_reference,o.created_at,u.email,p.name AS program_name FROM orders o JOIN users u ON u.id=o.user_id JOIN evaluation_programs p ON p.id=o.program_id ORDER BY o.created_at DESC LIMIT 100").all(),
          env.DB.prepare("SELECT cp.id,cp.status,cp.amount_usdt,cp.txid,cp.created_at,cp.paid_at,u.email,p.name AS program_name,c.status AS challenge_status FROM crypto_payments cp JOIN users u ON u.id=cp.user_id JOIN challenges c ON c.id=cp.challenge_id JOIN evaluation_programs p ON p.id=c.program_id ORDER BY cp.created_at DESC LIMIT 100").all()
        ]);
        return json({orders:orders.results,payments:payments.results});
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

async function encryptCredential(password,keyText) {
  const raw=Uint8Array.from(atob(keyText),c=>c.charCodeAt(0)); if(raw.length!==32) throw new Error('Key must be base64 for 32 bytes.');
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']); const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(password));
  return {ciphertext:toBase64(new Uint8Array(cipher)),iv:toBase64(iv)};
}
async function decryptCredential(ciphertext,ivText,keyText) {
  const raw=Uint8Array.from(atob(keyText),c=>c.charCodeAt(0)); if(raw.length!==32) throw new Error('Invalid key.');
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(ivText)},key,fromBase64(ciphertext)); return new TextDecoder().decode(clear);
}
async function sendMT5CredentialsEmail(env,challenge,account,delivery) {
  try {
    if(!env.RESEND_API_KEY||!env.MT5_EMAIL_FROM||!env.CREDENTIALS_ENCRYPTION_KEY) throw new Error('Email configuration missing.');
    const password=await decryptCredential(delivery.encrypted_password,delivery.encryption_iv,env.CREDENTIALS_ENCRYPTION_KEY);
    const login=String(account?.account_login||''), server=String(account?.server_name||'NEXFUND');
    const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const html='<div style="font-family:Arial,sans-serif;line-height:1.7"><h2>NEXFUND — بيانات حساب MetaTrader 5</h2><p>تم تجهيز حساب المحاكاة الخاص بك.</p><p><b>Server:</b> '+esc(server)+'<br><b>Login:</b> '+esc(login)+'<br><b>Password:</b> '+esc(password)+'<br><b>Balance:</b> '+Number(challenge.account_size_usd).toLocaleString('en-US')+' USD (virtual)</p><p>افتح MT5 واختر تسجيل الدخول إلى حساب موجود. هذا حساب محاكاة بأموال افتراضية وليس حساباً بأموال حقيقية.</p><p>غيّر كلمة المرور فور تسجيل الدخول إذا كان المزود يتيح ذلك، ولا تشاركها.</p><p>فريق NEXFUND</p></div>';
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.MT5_EMAIL_FROM,to:[challenge.email],subject:'بيانات حساب NEXFUND MT5',html})});
    if(!response.ok){const detail=await response.text();await env.DB.prepare("UPDATE mt5_account_deliveries SET email_status='failed',last_error=?,emailed_at=NULL WHERE id=?").bind(detail.slice(0,500),delivery.id).run();return {ok:false};}
    await env.DB.prepare("UPDATE mt5_account_deliveries SET email_status='sent',emailed_at=datetime('now'),last_error=NULL WHERE id=?").bind(delivery.id).run();
    await env.DB.prepare('INSERT INTO notifications (id,user_id,title,body) VALUES (?,?,?,?)').bind(id(),challenge.user_id,'حساب MT5 جاهز','أرسلنا بيانات الدخول إلى بريدك الإلكتروني المسجل. تحقق من الرسائل غير المرغوب فيها أيضاً.').run(); return {ok:true};
  } catch(error) { try{await env.DB.prepare("UPDATE mt5_account_deliveries SET email_status='failed',last_error=? WHERE id=?").bind(String(error).slice(0,500),delivery.id).run();}catch{} return {ok:false}; }
}
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
