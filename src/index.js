import { readSession, requireAdmin, requireSameOrigin } from "./auth.js";
import { json } from "./http.js";
import { evaluateChallenge } from "./risk-engine.js";
import { checkAuthRateLimit } from "./rate-limit.js";
import { isValidTronAddress } from "./tron-address.js";
import { snapshotChallengeRules, resolveChallengeRules } from "./challenge-rules.js";
import { isPurchaseEnabled, getPurchaseReadiness } from "./purchase-readiness.js";
import { remainingPayoutLimit, isAllowedPayoutTransition } from "./payout-rules.js";

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
async function ensureChallengeSnapshotSchema(db) {
  const columns = await db.prepare("PRAGMA table_info(challenges)").all();
  const names = new Set((columns.results || []).map(column => column.name));
  if (!names.has("trading_days_count")) await db.prepare("ALTER TABLE challenges ADD COLUMN trading_days_count INTEGER NOT NULL DEFAULT 0 CHECK (trading_days_count >= 0)").run();
  if (!names.has("last_provider_snapshot_at")) await db.prepare("ALTER TABLE challenges ADD COLUMN last_provider_snapshot_at TEXT").run();
  if (!names.has("rules_snapshot_json")) {
    try { await db.prepare("ALTER TABLE challenges ADD COLUMN rules_snapshot_json TEXT NOT NULL DEFAULT '{}'").run(); }
    catch (error) { const refreshed=await db.prepare("PRAGMA table_info(challenges)").all(); if (!(refreshed.results||[]).some(column=>column.name==="rules_snapshot_json")) throw error; }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS provider_snapshot_events (
    event_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    provider_timestamp TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_snapshot_events_challenge ON provider_snapshot_events(challenge_id, received_at)").run();
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

// Never fall back to a hard-coded wallet. Configure USDT_TRC20_ADDRESS as a secret/env var.
const getReceivingAddress = env => String(env.USDT_TRC20_ADDRESS || "").trim();

const id = () => crypto.randomUUID();
const rateLimited = (result) => json({ error: "Too many attempts. Please wait before trying again." }, 429, { "Retry-After": String(result.retryAfter) });

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
        const limit = await checkAuthRateLimit(env.DB, request, "register", { limit: 5, windowSeconds: 3600 });
        if (!limit.allowed) return rateLimited(limit);
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
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
        const limit = await checkAuthRateLimit(env.DB, request, "login", { limit: 8, windowSeconds: 900 });
        if (!limit.allowed) return rateLimited(limit);
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
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

      // Authenticated machine-to-machine provider snapshot ingestion. Requires migration 0004.
      if (url.pathname === "/api/internal/provider/snapshot" && request.method === "POST") {
        await ensureChallengeSnapshotSchema(env.DB);
        const configuredSecret = String(env.NEXFUND_PROVIDER_SYNC_SECRET || "");
        const suppliedSecret = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (configuredSecret.length < 32 || suppliedSecret.length !== configuredSecret.length || !constantTimeEqual(suppliedSecret, configuredSecret)) {
          return json({ error: "Provider authentication failed." }, 401);
        }
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
        const eventId = String(body.event_id || "");
        const snapshotAt = String(body.snapshot_at || "");
        const snapshotMillis = Date.parse(snapshotAt);
        const challengeId = String(body.challenge_id || "");
        const login = String(body.login || "");
        const balance = Number(body.balance);
        const equity = Number(body.equity);
        const dailyStartEquity = Number(body.daily_start_equity);
        const dailyStartDate = String(body.daily_start_date || "");
        const tradingDays = Number(body.trading_days);
        if (!eventId || eventId.length > 128 || !challengeId || challengeId.length > 128 || !Number.isFinite(snapshotMillis) || snapshotMillis > Date.now() + 120000 || !/^[0-9]{4,20}$/.test(login) ||
            !Number.isFinite(balance) || balance < 0 || !Number.isFinite(equity) || equity < 0 ||
            !Number.isFinite(dailyStartEquity) || dailyStartEquity <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dailyStartDate) ||
            !Number.isInteger(tradingDays) || tradingDays < 0 || tradingDays > 3650) {
          return json({ error: "Snapshot fields are invalid." }, 400);
        }
        const challenge = await env.DB.prepare(
          "SELECT c.id,c.user_id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.trading_days_count,c.last_provider_snapshot_at,c.rules_snapshot_json,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,p.min_trading_days,p.max_trading_days,p.rules_json,t.account_login FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id JOIN trading_accounts t ON t.challenge_id=c.id WHERE c.id=?"
        ).bind(challengeId).first();
        if (!challenge) return json({ error: "Challenge/account mapping not found." }, 404);
        if (challenge.status !== "active") return json({ error: "Only active challenges accept provider snapshots." }, 409);
        const challengeRules=resolveChallengeRules(challenge,challenge);
        if (String(challenge.account_login || "") !== login) return json({ error: "Provider login does not match the mapped account." }, 403);
        const previousEvent = await env.DB.prepare("SELECT event_id,challenge_id FROM provider_snapshot_events WHERE event_id=?").bind(eventId).first();
        if (previousEvent) return previousEvent.challenge_id === challengeId ? json({ ok: true, duplicate: true, message: "Snapshot event was already processed." }) : json({ error: "Provider event ID is already associated with another challenge." }, 409);
        if (challenge.last_provider_snapshot_at && snapshotAt <= challenge.last_provider_snapshot_at) return json({ error: "Stale provider snapshot rejected." }, 409);
        const evaluation = evaluateChallenge({
          initialBalance: Number(challenge.initial_balance),
          equity,
          dailyStartEquity,
          highWatermark: Number(challenge.high_watermark),
          tradingDays
        }, {
          dailyDrawdownPct: challengeRules.dailyDrawdownPct,
          maxDrawdownPct: challengeRules.maxDrawdownPct,
          profitTargetPct: challengeRules.profitTargetPct,
          minTradingDays: challengeRules.minTradingDays,
          maxTradingDays: challengeRules.maxTradingDays ?? undefined,
          trailingDrawdownPct: challengeRules.trailingDrawdownPct ?? undefined
        });
        const nextStatus = evaluation.status;
        const endedAt = nextStatus === "active" ? null : now();
        const snapshotIso = new Date(snapshotMillis).toISOString();
        // Claim the event and advance the challenge atomically. A concurrent or stale
        // event must not be recorded as processed unless its snapshot was applied.
        const snapshotWrite = await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO provider_snapshot_events (event_id,challenge_id,provider_timestamp,received_at) SELECT ?,?,?,datetime('now') WHERE EXISTS (SELECT 1 FROM challenges WHERE id=? AND status='active' AND (last_provider_snapshot_at IS NULL OR last_provider_snapshot_at < ?))")
            .bind(eventId,challengeId,snapshotIso,challengeId,snapshotIso),
          env.DB.prepare("UPDATE challenges SET current_balance=?,equity=?,high_watermark=?,daily_start_equity=?,daily_start_date=?,trading_days_count=?,last_provider_snapshot_at=?,status=?,failure_reason=?,ended_at=?,updated_at=datetime('now') WHERE id=? AND status='active' AND (last_provider_snapshot_at IS NULL OR last_provider_snapshot_at < ?) AND EXISTS (SELECT 1 FROM provider_snapshot_events WHERE event_id=? AND challenge_id=?)")
            .bind(balance,equity,evaluation.metrics.highWatermark,dailyStartEquity,dailyStartDate,tradingDays,snapshotIso,nextStatus,evaluation.failureReason,endedAt,challengeId,snapshotIso,eventId,challengeId)
        ]);
        if (Number(snapshotWrite?.[0]?.meta?.changes||0)!==1 || Number(snapshotWrite?.[1]?.meta?.changes||0)!==1) {
          return json({error:"Snapshot was not applied because a newer or concurrent event already updated this challenge. Retry with a new event ID and a fresh timestamp."},409);
        }
        await env.DB.prepare("UPDATE trading_accounts SET connection_status='connected',last_sync_at=datetime('now') WHERE challenge_id=?").bind(challengeId).run();
        const statements = [];
        for (const event of evaluation.events) {
          const dedupePeriod = event.type.startsWith("daily_") ? dailyStartDate : "lifetime";
          const riskId = "risk:" + challengeId + ":" + event.type + ":" + dedupePeriod;
          statements.push(env.DB.prepare("INSERT OR IGNORE INTO risk_events (id,challenge_id,event_type,severity,message,metric_value,threshold_value) VALUES (?,?,?,?,?,?,?)")
            .bind(riskId,challengeId,event.type,event.severity,event.type.replaceAll("_"," "),event.value,event.threshold));
          if (event.severity === "warning") {
            statements.push(env.DB.prepare("INSERT OR IGNORE INTO notifications (id,user_id,title,body) VALUES (?,?,?,?)")
              .bind(riskId + ":notice",challenge.user_id,"تنبيه إدارة المخاطر","اقترب حسابك من حد المخاطرة: " + event.type.replaceAll("_"," ") + ". راجع حدود التحدي قبل مواصلة التداول."));
          }
        }
        if (nextStatus === "passed" || nextStatus === "failed") {
          const noticeTitle = nextStatus === "passed" ? "Challenge passed" : "Challenge failed";
          const noticeBody = nextStatus === "passed" ? "Your evaluation has passed the automated rules check." : "Your evaluation failed a risk rule: " + String(evaluation.failureReason || "unknown");
          statements.push(env.DB.prepare("INSERT OR IGNORE INTO notifications (id,user_id,title,body) VALUES (?,?,?,?)").bind("challenge:"+challengeId+":"+nextStatus,challenge.user_id,noticeTitle,noticeBody));
        }
        if(statements.length) await env.DB.batch(statements);
        return json({ ok:true, status:nextStatus, failure_reason:evaluation.failureReason, metrics:evaluation.metrics, events:evaluation.events });
      }

      const session = await readSession(request, env.DB);
      if (!session) return json({ error: "Authentication required." }, 401);


      if (url.pathname === "/api/analytics" && request.method === "GET") {
        await ensureSimulatorTables(env.DB);
        const summary=await env.DB.prepare("SELECT COUNT(*) AS trades,COALESCE(SUM(pnl),0) AS net_pnl,COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) AS wins,COALESCE(SUM(CASE WHEN pnl<0 THEN 1 ELSE 0 END),0) AS losses,COALESCE(MAX(pnl),0) AS best_trade,COALESCE(MIN(pnl),0) AS worst_trade FROM simulator_trades WHERE user_id=?").bind(session.user_id).first();
        const account=await env.DB.prepare("SELECT balance,equity,updated_at FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        const daily=await env.DB.prepare("SELECT date(created_at) AS day,COUNT(*) AS trades,COALESCE(SUM(pnl),0) AS pnl,COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) AS wins FROM simulator_trades WHERE user_id=? AND created_at>=datetime('now','-30 days') GROUP BY date(created_at) ORDER BY day ASC").bind(session.user_id).all();
        const openPositions=await env.DB.prepare("SELECT symbol,side,quantity,entry_price,current_price,unrealized_pnl,opened_at FROM simulator_positions WHERE user_id=? AND status='open' ORDER BY opened_at DESC LIMIT 100").bind(session.user_id).all();
        const total=Number(summary?.trades||0), wins=Number(summary?.wins||0);
        return json({summary:{trades:total,net_pnl:Number(summary?.net_pnl||0),wins,losses:Number(summary?.losses||0),win_rate:total?wins/total*100:0,best_trade:Number(summary?.best_trade||0),worst_trade:Number(summary?.worst_trade||0)},account:account||null,daily:daily.results||[],open_positions:openPositions.results||[],data_source:"simulator"});
      }

      // Trader payout requests and admin review.
      if (url.pathname === "/api/payouts" && request.method === "GET") {
        await ensurePayoutTables(env.DB);
        const rows=await env.DB.prepare("SELECT id,challenge_id,requested_amount_usd,payout_wallet_address,status,admin_note,tx_reference,created_at,updated_at FROM payout_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(session.user_id).all();
        const eligible=await env.DB.prepare("SELECT id,initial_balance,current_balance,(SELECT COALESCE(SUM(requested_amount_usd),0) FROM payout_requests r WHERE r.challenge_id=challenges.id AND r.status IN ('pending','approved','paid')) AS reserved_payout FROM challenges WHERE user_id=? AND status='passed'").bind(session.user_id).all();
        return json({payouts:rows.results||[],eligible_challenges:(eligible.results||[]).map(c=>{const profit=Math.max(0,Number(c.current_balance)-Number(c.initial_balance));return {challenge_id:c.id,profit,max_payout_usd:remainingPayoutLimit(profit,Number(c.reserved_payout||0))};})});
      }
      if (url.pathname === "/api/payouts" && request.method === "POST") {
        await ensurePayoutTables(env.DB);
        const body=await request.json().catch(()=>null);if(!body)return json({error:"Invalid JSON body."},400);
        const challengeId=String(body.challenge_id||"").trim(), amount=Number(body.amount_usd), wallet=String(body.payout_wallet_address||"").trim();
        if(!challengeId||!Number.isFinite(amount)||amount<=0||amount>1000000)return json({error:"Enter a valid challenge and payout amount."},400);
        if(!(await isValidTronAddress(wallet)))return json({error:"Enter a valid USDT TRC20 (TRON) payout wallet address."},400);
        const challenge=await env.DB.prepare("SELECT id,initial_balance,current_balance,status FROM challenges WHERE id=? AND user_id=?").bind(challengeId,session.user_id).first();
        if(!challenge||challenge.status!=="passed")return json({error:"Payouts are available only for passed challenges."},403);
        const profit=Math.max(0,Number(challenge.current_balance)-Number(challenge.initial_balance)),maxPayout=profit*0.8;
        const reservedRow=await env.DB.prepare("SELECT COALESCE(SUM(requested_amount_usd),0) AS reserved FROM payout_requests WHERE challenge_id=? AND status IN ('pending','approved','paid')").bind(challengeId).first();
        const remainingPayout=remainingPayoutLimit(profit,Number(reservedRow?.reserved||0));
        if(profit<=0||amount>remainingPayout+0.000001)return json({error:"Requested amount exceeds the remaining payout limit.",max_payout_usd:remainingPayout},400);
        const pending=await env.DB.prepare("SELECT id FROM payout_requests WHERE challenge_id=? AND status IN ('pending','approved')").bind(challengeId).first();
        if(pending)return json({error:"A payout request for this challenge is already pending or approved."},409);
        const payoutId=id();
        const payoutBatch=await env.DB.batch([
          env.DB.prepare("INSERT INTO payout_requests(id,user_id,challenge_id,requested_amount_usd,payout_wallet_address,status) SELECT ?,c.user_id,c.id,?,?,'pending' FROM challenges c WHERE c.id=? AND c.user_id=? AND c.status='passed' AND ? <= ((c.current_balance-c.initial_balance)*0.8-COALESCE((SELECT SUM(r.requested_amount_usd) FROM payout_requests r WHERE r.challenge_id=c.id AND r.status IN ('pending','approved','paid')),0)) AND NOT EXISTS (SELECT 1 FROM payout_requests r WHERE r.challenge_id=c.id AND r.status IN ('pending','approved'))").bind(payoutId,amount,wallet,challengeId,session.user_id,amount),
          env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json) SELECT ?,?,?,'payout_request',?,? WHERE EXISTS (SELECT 1 FROM payout_requests WHERE id=?)").bind(id(),session.user_id,"payout.requested",payoutId,JSON.stringify({amount_usd:amount,challenge_id:challengeId,max_payout_usd:maxPayout}),payoutId)
        ]);
        if(Number(payoutBatch?.[0]?.meta?.changes||0)!==1)return json({error:"Payout limit changed or another request is already open. Refresh and try again.",max_payout_usd:remainingPayout},409);
        return json({ok:true,payout_id:payoutId,status:"pending",max_payout_usd:maxPayout},201);
      }
      // Admin operations overview: aggregated KPIs and recent challenge activity.
      if (url.pathname === "/api/admin/overview" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureCryptoPayments(env.DB);
        await ensurePayoutTables(env.DB);
        const [users, challenges, payments, payouts, recentChallenges] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended FROM users WHERE role='trader'").first(),
          env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM challenges").first(),
          env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid, COALESCE(SUM(CASE WHEN status='paid' THEN amount_usdt ELSE 0 END),0) AS confirmed_usdt FROM crypto_payments").first(),
          env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid, COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN requested_amount_usd ELSE 0 END),0) AS outstanding_usd FROM payout_requests").first(),
          env.DB.prepare("SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.created_at,u.email,p.name AS program_name FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id ORDER BY c.created_at DESC LIMIT 12").all()
        ]);
        return json({ ok:true, generated_at:now(), traders:users, challenges, payments, payouts, recent_challenges:recentChallenges.results||[] });
      }

      if (url.pathname === "/api/admin/system-readiness" && request.method === "GET") {
        const denied=requireAdmin(session);if(denied)return denied;
        const readiness=getPurchaseReadiness(env);
        const walletValid=await isValidTronAddress(getReceivingAddress(env));
        const checks=[
          {key:"payments",label:"تفعيل المدفوعات",ready:readiness.paymentsEnabled},
          {key:"wallet",label:"عنوان استقبال USDT TRC20 صالح",ready:walletValid},
          {key:"provider_url",label:"رابط مزود MT5 عبر HTTPS",ready:readiness.providerUrlValid},
          {key:"provider_key",label:"مفتاح مزود MT5",ready:readiness.providerApiKeyConfigured},
          {key:"encryption",label:"مفتاح تشفير بيانات الحسابات",ready:readiness.encryptionKeyValid},
          {key:"email",label:"إعداد إرسال البريد",ready:readiness.emailConfigured},
          {key:"trongrid",label:"مفتاح TRON Grid (اختياري لتحسين حدود الطلبات)",ready:Boolean(env.TRONGRID_API_KEY),optional:true}
        ];
        return json({purchase_enabled:isPurchaseEnabled(env)&&walletValid,checks,blocking:checks.filter(x=>!x.ready&&!x.optional).map(x=>x.key),generated_at:now()});
      }

      if (url.pathname === "/api/admin/audit-logs" && request.method === "GET") {
        const denied=requireAdmin(session);if(denied)return denied;
        const limit=Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get("limit")||"50",10)||50));
        const offset=Math.min(10000,Math.max(0,Number.parseInt(url.searchParams.get("offset")||"0",10)||0));
        const action=String(url.searchParams.get("action")||"").trim().slice(0,80);
        const targetType=String(url.searchParams.get("target_type")||"").trim().slice(0,60);
        const clauses=[],params=[];
        if(action){clauses.push("a.action LIKE ?");params.push("%"+action+"%");}
        if(targetType){clauses.push("a.target_type=?");params.push(targetType);}
        const where=clauses.length?" WHERE "+clauses.join(" AND "):"";
        const rows=await env.DB.prepare("SELECT a.id,a.action,a.target_type,a.target_id,a.details_json,a.created_at,u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id"+where+" ORDER BY a.created_at DESC LIMIT ? OFFSET ?")
          .bind(...params,limit,offset).all();
        const total=await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_logs a"+where).bind(...params).first();
        return json({logs:rows.results||[],total:Number(total?.total||0),limit,offset,generated_at:now()});
      }

      if (url.pathname === "/api/admin/payouts" && request.method === "GET") {
        const denied=requireAdmin(session);if(denied)return denied;
        await ensurePayoutTables(env.DB);
        const status=String(url.searchParams.get("status")||"");
        const rows=status&&["pending","approved","rejected","paid"].includes(status)
          ? await env.DB.prepare("SELECT r.*,u.email,c.initial_balance,c.current_balance FROM payout_requests r JOIN users u ON u.id=r.user_id JOIN challenges c ON c.id=r.challenge_id WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100").bind(status).all()
          : await env.DB.prepare("SELECT r.*,u.email,c.initial_balance,c.current_balance FROM payout_requests r JOIN users u ON u.id=r.user_id JOIN challenges c ON c.id=r.challenge_id ORDER BY r.created_at DESC LIMIT 100").all();
        return json({payouts:rows.results||[]});
      }
      if (url.pathname.startsWith("/api/admin/payouts/") && request.method === "PATCH") {
        const denied=requireAdmin(session);if(denied)return denied;
        await ensurePayoutTables(env.DB);
        const payoutId=url.pathname.split("/")[4],body=await request.json().catch(()=>null);
        const status=String(body?.status||""),note=String(body?.admin_note||"").trim().slice(0,1000),tx=String(body?.tx_reference||"").trim().slice(0,160);
        if(!["approved","rejected","paid"].includes(status))return json({error:"Invalid payout status."},400);
        if(status==="rejected"&&note.length<3)return json({error:"Please provide a reason for rejection."},400);
        if(status==="paid"&&tx.length<6)return json({error:"Provide the transaction reference before marking paid."},400);
        const payout=await env.DB.prepare("SELECT id,user_id,status,requested_amount_usd FROM payout_requests WHERE id=?").bind(payoutId).first();
        if(!payout)return json({error:"Payout request not found."},404);
        if(!isAllowedPayoutTransition(payout.status,status))return json({error:"Invalid payout status transition."},409);
        // Compare-and-set plus an in-statement uniqueness guard closes the race where
        // two administrators could assign the same transfer reference simultaneously.
        const transitionBatch=await env.DB.batch([
          env.DB.prepare("UPDATE payout_requests SET status=?,admin_note=?,tx_reference=?,reviewed_by=?,updated_at=datetime('now') WHERE id=? AND status=? AND (?<>'paid' OR NOT EXISTS (SELECT 1 FROM payout_requests WHERE tx_reference=? AND id<>?))")
            .bind(status,note,tx||null,session.user_id,payoutId,payout.status,status,tx,payoutId),
          env.DB.prepare("INSERT INTO notifications(id,user_id,title,body) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM payout_requests WHERE id=? AND status=? AND reviewed_by=?)")
            .bind(id(),payout.user_id,"تحديث طلب الأرباح","تم تحديث حالة طلب الأرباح إلى "+status+(note?" — "+note:"")+(tx?" — مرجع الدفع: "+tx:""),payoutId,status,session.user_id),
          env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json) SELECT ?,?,?,'payout_request',?,? WHERE EXISTS (SELECT 1 FROM payout_requests WHERE id=? AND status=? AND reviewed_by=?)")
            .bind(id(),session.user_id,"payout."+status,payoutId,JSON.stringify({amount_usd:payout.requested_amount_usd,previous_status:payout.status,new_status:status,note,tx_reference:tx,changed_at:now()}),payoutId,status,session.user_id)
        ]);
        if(Number(transitionBatch?.[0]?.meta?.changes||0)!==1){
          const duplicateTx=status==="paid"?await env.DB.prepare("SELECT id FROM payout_requests WHERE tx_reference=? AND id<>? LIMIT 1").bind(tx,payoutId).first():null;
          if(duplicateTx)return json({error:"This transaction reference is already assigned to another payout."},409);
          return json({error:"Payout was updated by another administrator or its transfer reference is already in use. Refresh and review its current status."},409);
        }
        return json({ok:true,status});
      }

      // Notifications center API.
      if (url.pathname === "/api/notifications" && request.method === "GET") {
        await ensureNotificationTable(env.DB);
        const limit=Math.min(50,Math.max(1,Number(url.searchParams.get("limit")||20)));
        const rows=await env.DB.prepare("SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?").bind(session.user_id,limit).all();
        const unread=await env.DB.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL").bind(session.user_id).first();
        return json({notifications:rows.results||[],unread_count:Number(unread?.count||0)});
      }
      if (url.pathname === "/api/notifications/read-all" && request.method === "POST") {
        await ensureNotificationTable(env.DB);
        await env.DB.prepare("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL").bind(session.user_id).run();
        return json({ok:true});
      }
      if (url.pathname.startsWith("/api/notifications/") && url.pathname.endsWith("/read") && request.method === "PATCH") {
        await ensureNotificationTable(env.DB);
        const notificationId=url.pathname.split("/")[3];
        const result=await env.DB.prepare("UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=? AND read_at IS NULL").bind(notificationId,session.user_id).run();
        return json({ok:true,updated:result.meta?.changes||0});
      }
      if (url.pathname === "/api/admin/notifications/broadcast" && request.method === "POST") {
        const denied=requireAdmin(session); if(denied) return denied;
        await ensureNotificationTable(env.DB);
        const body=await request.json().catch(()=>null); if(!body) return json({error:"Invalid JSON body."},400);
        const title=String(body.title||"").trim(), message=String(body.body||"").trim();
        if(title.length<3||title.length>140||message.length<5||message.length>2000) return json({error:"Title must be 3–140 chars and message 5–2000 chars."},400);
        const users=await env.DB.prepare("SELECT id FROM users").all();
        const statements=users.results.map(u=>env.DB.prepare("INSERT INTO notifications(id,user_id,title,body) VALUES(?,?,?,?)").bind(id(),u.id,title,message));
        if(statements.length) await env.DB.batch(statements);
        return json({ok:true,delivered:statements.length});
      }

      // Support tickets: authenticated trader ticket lifecycle and admin review.
      if (url.pathname === "/api/support/tickets" && request.method === "GET") {
        await ensureSupportTables(env.DB);
        const rows = await env.DB.prepare("SELECT id,category,subject,status,priority,created_at,updated_at FROM support_tickets WHERE user_id=? ORDER BY updated_at DESC LIMIT 50").bind(session.user_id).all();
        return json({ tickets: rows.results });
      }
      if (url.pathname === "/api/support/tickets" && request.method === "POST") {
        await ensureSupportTables(env.DB);
        const body=await request.json().catch(()=>null); if(!body) return json({error:"Invalid JSON body."},400);
        const category=String(body.category||"other"), subject=String(body.subject||"").trim(), message=String(body.message||"").trim();
        if(!["payment","account","challenge","technical","other"].includes(category)) return json({error:"Invalid ticket category."},400);
        if(subject.length<4||subject.length>120||message.length<10||message.length>4000) return json({error:"Subject must be 4–120 characters and message 10–4000 characters."},400);
        const ticketId=id(),messageId=id();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO support_tickets(id,user_id,category,subject,status,priority) VALUES(?,?,?,?,'open','normal')").bind(ticketId,session.user_id,category,subject),
          env.DB.prepare("INSERT INTO support_ticket_messages(id,ticket_id,author_user_id,author_role,message) VALUES(?,?,?,'trader',?)").bind(messageId,ticketId,session.user_id,message)
        ]);
        return json({ok:true,ticket_id:ticketId,status:"open"},201);
      }
      if (url.pathname.startsWith("/api/support/tickets/") && request.method === "GET") {
        await ensureSupportTables(env.DB);
        const ticketId=url.pathname.split("/")[4];
        const ticket=await env.DB.prepare("SELECT id,category,subject,status,priority,created_at,updated_at FROM support_tickets WHERE id=? AND user_id=?").bind(ticketId,session.user_id).first();
        if(!ticket) return json({error:"Ticket not found."},404);
        const messages=await env.DB.prepare("SELECT id,author_role,message,created_at FROM support_ticket_messages WHERE ticket_id=? ORDER BY created_at ASC").bind(ticketId).all();
        return json({ticket,messages:messages.results});
      }
      if (url.pathname.startsWith("/api/support/tickets/") && url.pathname.endsWith("/messages") && request.method === "POST") {
        await ensureSupportTables(env.DB);
        const ticketId=url.pathname.split("/")[4], body=await request.json().catch(()=>null);
        const message=String(body?.message||"").trim(); if(message.length<2||message.length>4000) return json({error:"Message must be 2–4000 characters."},400);
        const ticket=await env.DB.prepare("SELECT id,status FROM support_tickets WHERE id=? AND user_id=?").bind(ticketId,session.user_id).first();
        if(!ticket) return json({error:"Ticket not found."},404);
        if(ticket.status==="closed") return json({error:"This ticket is closed."},409);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO support_ticket_messages(id,ticket_id,author_user_id,author_role,message) VALUES(?,?,?,'trader',?)").bind(id(),ticketId,session.user_id,message),
          env.DB.prepare("UPDATE support_tickets SET status='open',updated_at=datetime('now') WHERE id=?").bind(ticketId)
        ]);
        return json({ok:true});
      }
      if (url.pathname === "/api/admin/support/tickets" && request.method === "GET") {
        const denied=requireAdmin(session); if(denied) return denied;
        await ensureSupportTables(env.DB);
        const status=String(url.searchParams.get("status")||"");
        const rows=status&&["open","in_progress","resolved","closed"].includes(status)
          ? await env.DB.prepare("SELECT t.id,t.user_id,t.category,t.subject,t.status,t.priority,t.created_at,t.updated_at,u.email FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.status=? ORDER BY t.updated_at DESC LIMIT 100").bind(status).all()
          : await env.DB.prepare("SELECT t.id,t.user_id,t.category,t.subject,t.status,t.priority,t.created_at,t.updated_at,u.email FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 100").all();
        return json({tickets:rows.results});
      }
      if (url.pathname.startsWith("/api/admin/support/tickets/") && url.pathname.endsWith("/messages") && request.method === "GET") {
        const denied=requireAdmin(session); if(denied) return denied;
        await ensureSupportTables(env.DB);
        const ticketId=url.pathname.split("/")[5];
        const ticket=await env.DB.prepare("SELECT t.*,u.email FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?").bind(ticketId).first();
        if(!ticket) return json({error:"Ticket not found."},404);
        const messages=await env.DB.prepare("SELECT id,author_role,message,created_at FROM support_ticket_messages WHERE ticket_id=? ORDER BY created_at ASC").bind(ticketId).all();
        return json({ticket,messages:messages.results});
      }
      if (url.pathname.startsWith("/api/admin/support/tickets/") && url.pathname.endsWith("/messages") && request.method === "POST") {
        const denied=requireAdmin(session); if(denied) return denied;
        await ensureSupportTables(env.DB);
        const ticketId=url.pathname.split("/")[5], body=await request.json().catch(()=>null);
        const message=String(body?.message||"").trim(); if(message.length<2||message.length>4000) return json({error:"Message must be 2–4000 characters."},400);
        const ticket=await env.DB.prepare("SELECT id,user_id,status FROM support_tickets WHERE id=?").bind(ticketId).first();
        if(!ticket) return json({error:"Ticket not found."},404);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO support_ticket_messages(id,ticket_id,author_user_id,author_role,message) VALUES(?,?,?,'admin',?)").bind(id(),ticketId,session.user_id,message),
          env.DB.prepare("UPDATE support_tickets SET status='in_progress',updated_at=datetime('now') WHERE id=? AND status IN ('open','in_progress')").bind(ticketId),
          env.DB.prepare("INSERT INTO notifications(id,user_id,title,body) VALUES(?,?,?,?)").bind(id(),ticket.user_id,"رد جديد من دعم NEXFUND","تم الرد على تذكرتك: "+ticketId)
        ]);
        return json({ok:true});
      }
      if (url.pathname.startsWith("/api/admin/support/tickets/") && request.method === "PATCH") {
        const denied=requireAdmin(session); if(denied) return denied;
        await ensureSupportTables(env.DB);
        const ticketId=url.pathname.split("/")[5], body=await request.json().catch(()=>null), status=String(body?.status||"");
        if(!["open","in_progress","resolved","closed"].includes(status)) return json({error:"Invalid ticket status."},400);
        const ticket=await env.DB.prepare("SELECT id,user_id FROM support_tickets WHERE id=?").bind(ticketId).first();
        if(!ticket) return json({error:"Ticket not found."},404);
        await env.DB.batch([
          env.DB.prepare("UPDATE support_tickets SET status=?,updated_at=datetime('now') WHERE id=?").bind(status,ticketId),
          env.DB.prepare("INSERT INTO notifications(id,user_id,title,body) VALUES(?,?,?,?)").bind(id(),ticket.user_id,"تحديث حالة تذكرتك","تم تحديث حالة التذكرة إلى: "+status)
        ]);
        return json({ok:true,status});
      }

      if (url.pathname === "/api/programs" && request.method === "GET") {
        await ensureDefaultPrograms(env.DB);
        const rows = await env.DB.prepare("SELECT id,name,description,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,max_trading_days FROM evaluation_programs WHERE status='active' ORDER BY account_size_usd ASC").all();
        return json({ programs: rows.results, pricing_status: "provisional", purchase_enabled: isPurchaseEnabled(env), purchase_readiness: getPurchaseReadiness(env) });
      }

      if (url.pathname === "/api/challenges" && request.method === "POST") {
        if (!isPurchaseEnabled(env)) return json({ error: "Challenge purchases are unavailable until payment verification and MT5 provisioning are configured." }, 503);
        if (!(await isValidTronAddress(getReceivingAddress(env)))) return json({ error: "The configured USDT TRC20 receiving wallet is invalid. Contact platform support." }, 503);
        await ensureCryptoPayments(env.DB);
        const body = await request.json();
        const programId = String(body.program_id || "");
        const platform = String(body.platform || "");
        if (platform !== "MT5") return json({ error: "Currently only MetaTrader 5 (MT5) is supported." }, 400);
        await ensureDefaultPrograms(env.DB);
        await ensureChallengeSnapshotSchema(env.DB);
        const program = await env.DB.prepare("SELECT id,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,max_trading_days,rules_json FROM evaluation_programs WHERE id=? AND status='active'").bind(programId).first();
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
          env.DB.prepare("INSERT INTO challenges (id,user_id,program_id,status,initial_balance,current_balance,equity,high_watermark,daily_start_equity,daily_start_date,rules_snapshot_json) VALUES (?,?,?,'pending',?,?,?,?,?,?,?)")
            .bind(challengeId, session.user_id, program.id, balance, balance, balance, balance, balance, today, JSON.stringify(snapshotChallengeRules(program))),
          env.DB.prepare("INSERT INTO trading_accounts (id,challenge_id,platform,integration_mode,connection_status) VALUES (?,?,?,'demo','not_connected')")
            .bind(id(), challengeId, platform),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'challenge',?,?)")
            .bind(id(), session.user_id, "challenge.selection_created", challengeId, JSON.stringify({ platform, program_id: program.id })),
          env.DB.prepare("INSERT INTO crypto_payments (id,challenge_id,user_id,amount_usdt,status) VALUES (?,?,?,? ,'pending')")
            .bind(paymentId, challengeId, session.user_id, Number(program.fee_usd))
        ]);
        return json({ ok: true, challenge_id: challengeId, payment_id: paymentId, status: "pending", platform, message: "Selection saved. Complete USDT TRC20 payment to activate the evaluation." }, 201);
      }

      if (url.pathname === "/api/payments" && request.method === "GET") {
        await ensureCryptoPayments(env.DB);
        const rows = await env.DB.prepare(
          "SELECT cp.id,cp.challenge_id,cp.amount_usdt,cp.status,cp.txid,cp.created_at,cp.updated_at,cp.paid_at,p.name AS program_name,c.initial_balance AS account_size_usd FROM crypto_payments cp JOIN challenges c ON c.id=cp.challenge_id JOIN evaluation_programs p ON p.id=c.program_id WHERE cp.user_id=? ORDER BY cp.created_at DESC LIMIT 100"
        ).bind(session.user_id).all();
        return json({ payments: rows.results || [] });
      }

      if (url.pathname.startsWith("/api/payments/") && request.method === "GET") {
        await ensureCryptoPayments(env.DB);
        const paymentId = url.pathname.split("/")[3];
        const payment = await env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid,created_at,paid_at FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!payment) return json({ error: "Payment request not found." }, 404);
        return json({ payment, network: "TRON (TRC20)", token: "USDT", receiving_address: getReceivingAddress(env), configuration_ready: Boolean(getReceivingAddress(env)), payment_enabled: isPurchaseEnabled(env) });
      }

      if (url.pathname.startsWith("/api/payments/") && url.pathname.endsWith("/verify") && request.method === "POST") {
        await ensureCryptoPayments(env.DB);
        if (!isPurchaseEnabled(env)) return json({ error: "Crypto payments are not enabled until payment verification and MT5 provisioning are configured." }, 503);
        if (!(await isValidTronAddress(getReceivingAddress(env)))) return json({ error: "Receiving address is missing or is not a valid TRON wallet." }, 503);
        const paymentId = url.pathname.split("/")[3];
        const body = await request.json();
        const txid = String(body.txid || "").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) return json({ error: "Enter a valid 64-character TRON transaction ID." }, 400);
        const payment = await env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!payment) return json({ error: "Payment request not found." }, 404);
        if (payment.status === "paid") return json({ ok: true, status: "paid", txid: payment.txid, message: "Payment was already confirmed." });
        if (payment.status !== "pending") return json({ error: "This payment request is no longer pending." }, 409);
        const used = await env.DB.prepare("SELECT id FROM crypto_payments WHERE txid=? AND status='paid'").bind(txid).first();
        if (used) return json({ error: "This transaction has already been used." }, 409);

        const receivingAddress = getReceivingAddress(env);
        const apiUrl = "https://api.trongrid.io/v1/accounts/" + encodeURIComponent(receivingAddress) +
          "/transactions/trc20?only_confirmed=true&limit=200&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        const headers = {};
        if (env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = env.TRONGRID_API_KEY;
        const chainResponse = await fetch(apiUrl, { headers });
        if (!chainResponse.ok) return json({ error: "Could not verify the transaction with TRON right now. Try again later." }, 502);
        const chainData = await chainResponse.json();
        const transfer = (chainData.data || []).find(item =>
          String(item.transaction_id || "").toLowerCase() === txid &&
          String(item.to || "").toLowerCase() === receivingAddress.toLowerCase() &&
          String(item.token_info?.address || "").toLowerCase() === "tr7nhqjekqxgtci8q8zy4p8lotszgjlj6t" &&
          String(item.type || "").toLowerCase() === "transfer"
        );
        if (!transfer) return json({ error: "No confirmed incoming USDT TRC20 transfer matching this transaction was found. Check the network, recipient and confirmation status." }, 400);
        const receivedMicros = BigInt(String(transfer.value || "0"));
        const expectedMicros = BigInt(Math.round(Number(payment.amount_usdt) * 1_000_000));
        if (receivedMicros !== expectedMicros) return json({ error: "The confirmed transfer amount does not match the requested amount." }, 400);
        if (payment.txid && payment.txid !== txid) return json({ error: "A different transaction ID is already attached to this payment." }, 409);

        try {
          await env.DB.batch([
            env.DB.prepare("UPDATE crypto_payments SET txid=?,status='paid',paid_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='pending' AND txid IS NULL").bind(txid, paymentId),
            env.DB.prepare("UPDATE challenges SET updated_at=datetime('now') WHERE id=? AND user_id=? AND status='pending' AND EXISTS (SELECT 1 FROM crypto_payments WHERE id=? AND status='paid' AND txid=?)").bind(payment.challenge_id, session.user_id, paymentId, txid),
            env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) SELECT ?, ?, ?,'crypto_payment',?,? WHERE EXISTS (SELECT 1 FROM crypto_payments WHERE id=? AND status='paid' AND txid=?)")
              .bind(id(), session.user_id, "crypto_payment.confirmed", paymentId, JSON.stringify({ txid, amount_usdt: payment.amount_usdt, network: "TRC20" }), paymentId, txid)
          ]);
        } catch (error) {
          const duplicate = await env.DB.prepare("SELECT id FROM crypto_payments WHERE txid=? AND id<>?").bind(txid, paymentId).first();
          if (duplicate) return json({ error: "This transaction has already been assigned to another payment." }, 409);
          throw error;
        }
        const confirmed = await env.DB.prepare("SELECT status,txid FROM crypto_payments WHERE id=? AND user_id=?").bind(paymentId, session.user_id).first();
        if (!confirmed || confirmed.status !== "paid" || confirmed.txid !== txid) {
          if (confirmed?.status === "paid") return json({ error: "A different transaction was confirmed for this payment." }, 409);
          return json({ error: "Payment confirmation could not be committed. Please retry safely." }, 409);
        }
        return json({ ok: true, status: "paid", challenge_status: "pending", txid, message: "Payment confirmed. Your challenge is awaiting account provisioning; it will become active only after the trading account is successfully created." });
      }

      // NEXFUND paper simulator: isolated virtual accounts and trade ledger (no broker or real-money execution).
      if (url.pathname === "/api/simulator/account" && request.method === "GET") {
        await ensureSimulatorTables(env.DB);
        const account = await env.DB.prepare("SELECT id,balance,equity,created_at,updated_at FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        const trades = await env.DB.prepare("SELECT id,symbol,side,quantity,entry_price,exit_price,pnl,status,created_at,closed_at FROM simulator_trades WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(session.user_id).all();
        const positions = await env.DB.prepare("SELECT id,symbol,side,quantity,entry_price,current_price,stop_loss,take_profit,unrealized_pnl,status,opened_at,closed_at FROM simulator_positions WHERE user_id=? ORDER BY opened_at DESC LIMIT 100").bind(session.user_id).all();
        const unrealized = positions.results.filter(p=>p.status==="open").reduce((sum,p)=>sum+Number(p.unrealized_pnl||0),0);
        const accountView=account?{...account,equity:Number(account.balance)+unrealized,unrealized_pnl:unrealized}:null;
        return json({ account: accountView, positions: positions.results, trades: trades.results, mode: "paper", disclaimer: "Simulated trades only. Prices are user-entered and are not live market quotes." });
      }

      if (url.pathname === "/api/simulator/account" && request.method === "POST") {
        await ensureSimulatorTables(env.DB);
        const existing = await env.DB.prepare("SELECT id,balance,equity,created_at,updated_at FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        if (existing) return json({ account: existing, reused: true, mode: "paper" });
        const accountId=id();
        await env.DB.prepare("INSERT INTO simulator_accounts(id,user_id,balance,equity) VALUES(?,?,10000,10000)").bind(accountId,session.user_id).run();
        const account=await env.DB.prepare("SELECT id,balance,equity,created_at,updated_at FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        return json({ account, created: true, mode: "paper" },201);
      }

      // Paper simulator position lifecycle: open, mark and close virtual positions.
      if (url.pathname === "/api/simulator/positions" && request.method === "GET") {
        await ensureSimulatorTables(env.DB);
        const positions = await env.DB.prepare("SELECT id,symbol,side,quantity,entry_price,current_price,stop_loss,take_profit,unrealized_pnl,status,opened_at,closed_at FROM simulator_positions WHERE user_id=? ORDER BY opened_at DESC LIMIT 100").bind(session.user_id).all();
        return json({ positions: positions.results, mode: "paper" });
      }

      if (url.pathname === "/api/simulator/positions" && request.method === "POST") {
        await ensureSimulatorTables(env.DB);
        const body=await request.json().catch(()=>null);
        if(!body) return json({error:"Invalid JSON body."},400);
        const symbol=String(body.symbol||"").trim().toUpperCase(), side=String(body.side||"").toLowerCase();
        const quantity=Number(body.quantity), entry=Number(body.entry_price), stop=body.stop_loss==null?null:Number(body.stop_loss), target=body.take_profit==null?null:Number(body.take_profit);
        if(!/^[A-Z0-9._-]{2,20}$/.test(symbol)||!["buy","sell"].includes(side)||!Number.isFinite(quantity)||quantity<=0||quantity>100000||!Number.isFinite(entry)||entry<=0||(stop!==null&&(!Number.isFinite(stop)||stop<=0))||(target!==null&&(!Number.isFinite(target)||target<=0))) return json({error:"Invalid position parameters."},400);
        if(side==="buy"&&((stop!==null&&stop>=entry)||(target!==null&&target<=entry))) return json({error:"For BUY, stop loss must be below entry and take profit above entry."},400);
        if(side==="sell"&&((stop!==null&&stop<=entry)||(target!==null&&target>=entry))) return json({error:"For SELL, stop loss must be above entry and take profit below entry."},400);
        const account=await env.DB.prepare("SELECT id,balance FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        if(!account) return json({error:"Create your paper account first."},404);
        const exposure=quantity*entry;
        if(!Number.isFinite(exposure)||exposure>Number(account.balance)*20) return json({error:"Position size exceeds the simulator's 20x notional exposure limit."},400);
        const positionId=id();
        await env.DB.prepare("INSERT INTO simulator_positions(id,user_id,account_id,symbol,side,quantity,entry_price,current_price,stop_loss,take_profit,unrealized_pnl,status) VALUES(?,?,?,?,?,?,?,?,?,?,0,'open')").bind(positionId,session.user_id,account.id,symbol,side,quantity,entry,entry,stop,target).run();
        await env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json) VALUES(?,?,?,'simulator_position',?,?)").bind(id(),session.user_id,"simulator.position_opened",positionId,JSON.stringify({symbol,side,quantity,entry_price:entry,stop_loss:stop,take_profit:target})).run();
        return json({ok:true,position:{id:positionId,symbol,side,quantity,entry_price:entry,current_price:entry,stop_loss:stop,take_profit:target,unrealized_pnl:0,status:"open"}},201);
      }

      const markMatch=url.pathname.match(/^\/api\/simulator\/positions\/([a-f0-9-]+)\/mark$/i);
      if(markMatch&&request.method==="POST"){
        await ensureSimulatorTables(env.DB);
        const body=await request.json().catch(()=>null), price=Number(body?.current_price);
        if(!Number.isFinite(price)||price<=0) return json({error:"current_price must be a positive number."},400);
        const pos=await env.DB.prepare("SELECT id,side,quantity,entry_price,stop_loss,take_profit,status FROM simulator_positions WHERE id=? AND user_id=?").bind(markMatch[1],session.user_id).first();
        if(!pos) return json({error:"Position not found."},404);
        if(pos.status!=="open") return json({error:"Only open positions can be marked."},409);
        const pnl=(pos.side==="buy"?price-Number(pos.entry_price):Number(pos.entry_price)-price)*Number(pos.quantity);
        const hitStop=pos.stop_loss!==null&&(pos.side==="buy"?price<=Number(pos.stop_loss):price>=Number(pos.stop_loss));
        const hitTarget=pos.take_profit!==null&&(pos.side==="buy"?price>=Number(pos.take_profit):price<=Number(pos.take_profit));
        if(hitStop||hitTarget){
          const finalPrice=hitStop?Number(pos.stop_loss):Number(pos.take_profit);
          const finalPnl=(pos.side==="buy"?finalPrice-Number(pos.entry_price):Number(pos.entry_price)-finalPrice)*Number(pos.quantity);
          const account=await env.DB.prepare("SELECT balance FROM simulator_accounts WHERE id IN (SELECT account_id FROM simulator_positions WHERE id=? AND user_id=?)").bind(pos.id,session.user_id).first();
          const newBalance=Number(account.balance)+finalPnl;
          await env.DB.batch([
            env.DB.prepare("UPDATE simulator_positions SET current_price=?,unrealized_pnl=0,status='closed',closed_at=datetime('now'),exit_price=?,realized_pnl=?,close_reason=? WHERE id=? AND user_id=? AND status='open'").bind(finalPrice,finalPrice,finalPnl,hitStop?"stop_loss":"take_profit",pos.id,session.user_id),
            env.DB.prepare("UPDATE simulator_accounts SET balance=?,equity=?,updated_at=datetime('now') WHERE id IN (SELECT account_id FROM simulator_positions WHERE id=? AND user_id=?)").bind(newBalance,newBalance,pos.id,session.user_id),
            env.DB.prepare("INSERT INTO simulator_trades(id,user_id,account_id,symbol,side,quantity,entry_price,exit_price,pnl,status,closed_at) SELECT ?,user_id,account_id,symbol,side,quantity,entry_price,?,?, 'closed',datetime('now') FROM simulator_positions WHERE id=? AND user_id=?").bind(id(),finalPrice,finalPnl,pos.id,session.user_id)
          ]);
          return json({ok:true,auto_closed:true,reason:hitStop?"stop_loss":"take_profit",exit_price:finalPrice,realized_pnl:finalPnl});
        }
        await env.DB.prepare("UPDATE simulator_positions SET current_price=?,unrealized_pnl=? WHERE id=? AND user_id=? AND status='open'").bind(price,pnl,pos.id,session.user_id).run();
        const open=await env.DB.prepare("SELECT id,symbol,side,quantity,entry_price,current_price,stop_loss,take_profit,unrealized_pnl,status FROM simulator_positions WHERE id=? AND user_id=?").bind(pos.id,session.user_id).first();
        const sum=await env.DB.prepare("SELECT COALESCE(SUM(unrealized_pnl),0) AS total FROM simulator_positions WHERE user_id=? AND status='open'").bind(session.user_id).first();
        const account=await env.DB.prepare("SELECT balance FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        return json({ok:true,position:open,account:{balance:Number(account.balance),equity:Number(account.balance)+Number(sum.total)}});
      }

      const closeMatch=url.pathname.match(/^\/api\/simulator\/positions\/([a-f0-9-]+)\/close$/i);
      if(closeMatch&&request.method==="POST"){
        await ensureSimulatorTables(env.DB);
        const body=await request.json().catch(()=>({}));
        const closePrice=Number(body?.exit_price);
        if(!Number.isFinite(closePrice)||closePrice<=0) return json({error:"exit_price must be a positive number."},400);
        const pos=await env.DB.prepare("SELECT id,account_id,symbol,side,quantity,entry_price,status FROM simulator_positions WHERE id=? AND user_id=?").bind(closeMatch[1],session.user_id).first();
        if(!pos) return json({error:"Position not found."},404);
        if(pos.status!=="open") return json({error:"Position is already closed."},409);
        const pnl=(pos.side==="buy"?closePrice-Number(pos.entry_price):Number(pos.entry_price)-closePrice)*Number(pos.quantity);
        const account=await env.DB.prepare("SELECT balance FROM simulator_accounts WHERE id=? AND user_id=?").bind(pos.account_id,session.user_id).first();
        const newBalance=Number(account.balance)+pnl;
        await env.DB.batch([
          env.DB.prepare("UPDATE simulator_positions SET current_price=?,unrealized_pnl=0,status='closed',closed_at=datetime('now'),exit_price=?,realized_pnl=?,close_reason='manual' WHERE id=? AND user_id=? AND status='open'").bind(closePrice,closePrice,pnl,pos.id,session.user_id),
          env.DB.prepare("UPDATE simulator_accounts SET balance=?,equity=?,updated_at=datetime('now') WHERE id=? AND user_id=?").bind(newBalance,newBalance,pos.account_id,session.user_id),
          env.DB.prepare("INSERT INTO simulator_trades(id,user_id,account_id,symbol,side,quantity,entry_price,exit_price,pnl,status,closed_at) VALUES(?,?,?,?,?,?,?,?,?,'closed',datetime('now'))").bind(id(),session.user_id,pos.account_id,pos.symbol,pos.side,pos.quantity,pos.entry_price,closePrice,pnl),
          env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json) VALUES(?,?,?,'simulator_position',?,?)").bind(id(),session.user_id,"simulator.position_closed",pos.id,JSON.stringify({exit_price:closePrice,pnl}))
        ]);
        return json({ok:true,position_id:pos.id,exit_price:closePrice,realized_pnl:pnl,account:{balance:newBalance,equity:newBalance}});
      }

      if (url.pathname === "/api/simulator/trades" && request.method === "POST") {
        await ensureSimulatorTables(env.DB);
        const body=await request.json().catch(()=>null);
        if (!body) return json({error:"Invalid JSON body."},400);
        const symbol=String(body.symbol||"").trim().toUpperCase();
        const side=String(body.side||"").toLowerCase();
        const quantity=Number(body.quantity), entryPrice=Number(body.entry_price), exitPrice=Number(body.exit_price);
        if (!/^[A-Z0-9._-]{2,20}$/.test(symbol) || !["buy","sell"].includes(side) || !Number.isFinite(quantity)||quantity<=0||quantity>100000||!Number.isFinite(entryPrice)||entryPrice<=0||!Number.isFinite(exitPrice)||exitPrice<=0)
          return json({error:"Provide a valid symbol, side, positive quantity and entry/exit prices."},400);
        const account=await env.DB.prepare("SELECT id,balance,equity FROM simulator_accounts WHERE user_id=?").bind(session.user_id).first();
        if (!account) return json({error:"Create your paper account first."},404);
        const pnl=(side==="buy" ? exitPrice-entryPrice : entryPrice-exitPrice)*quantity;
        const newBalance=Number(account.balance)+pnl;
        if (!Number.isFinite(newBalance)) return json({error:"Trade calculation failed."},400);
        const tradeId=id();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO simulator_trades(id,user_id,account_id,symbol,side,quantity,entry_price,exit_price,pnl,status,closed_at) VALUES(?,?,?,?,?,?,?,?,?,'closed',datetime('now'))").bind(tradeId,session.user_id,account.id,symbol,side,quantity,entryPrice,exitPrice,pnl),
          env.DB.prepare("UPDATE simulator_accounts SET balance=?,equity=?,updated_at=datetime('now') WHERE id=? AND user_id=?").bind(newBalance,newBalance,account.id,session.user_id),
          env.DB.prepare("INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json) VALUES(?,?,?,'simulator_trade',?,?)").bind(id(),session.user_id,"simulator.trade_closed",tradeId,JSON.stringify({symbol,side,quantity,entry_price:entryPrice,exit_price:exitPrice,pnl}))
        ]);
        return json({ok:true,trade:{id:tradeId,symbol,side,quantity,entry_price:entryPrice,exit_price:exitPrice,pnl},account:{balance:newBalance,equity:newBalance}},201);
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        await ensureChallengeSnapshotSchema(env.DB);
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`).run();
        let challenges;
        try {
          challenges = await env.DB.prepare(
            "SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.trading_days_count,c.rules_snapshot_json,c.started_at,c.ended_at,c.failure_reason,c.last_provider_snapshot_at,c.created_at,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,t.platform,t.connection_status,t.account_login,t.server_name FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE c.user_id=? ORDER BY c.created_at DESC"
          ).bind(session.user_id).all();
        } catch (error) {
          console.error("NEXFUND dashboard challenges query failed", error);
          return json({ error: "تعذر تحميل حسابات التحدي.", code: "DASHBOARD_CHALLENGES_QUERY_FAILED" }, 500);
        }
        let notifications;
        try {
          notifications = await env.DB.prepare("SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20").bind(session.user_id).all();
        } catch (error) {
          console.error("NEXFUND dashboard notifications query failed", error);
          notifications = { results: [] };
        }
        return json({ challenges: challenges.results || [], notifications: notifications.results || [] });
      }

      if (url.pathname === "/api/challenges" && request.method === "GET") {
        await ensureChallengeSnapshotSchema(env.DB);
        const rows = await env.DB.prepare("SELECT c.*,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,p.min_trading_days,p.max_trading_days,p.rules_json FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id WHERE c.user_id=? ORDER BY c.created_at DESC")
          .bind(session.user_id).all();
        const challenges=(rows.results||[]).map(row=>{const rules=resolveChallengeRules(row,row);return {...row,profit_target_pct:rules.profitTargetPct,daily_drawdown_pct:rules.dailyDrawdownPct,max_drawdown_pct:rules.maxDrawdownPct,min_trading_days:rules.minTradingDays,max_trading_days:rules.maxTradingDays};});
        return json({ challenges });
      }

      if (url.pathname === "/api/admin/challenges/pending-provisioning" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureMT5DeliveryTable(env.DB);
        const rows = await env.DB.prepare(
          "SELECT c.id AS challenge_id,u.email,p.name AS program_name,c.initial_balance AS account_size_usd,cp.amount_usdt,cp.paid_at,c.created_at,td.email_status,t.account_login,t.server_name FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id JOIN crypto_payments cp ON cp.challenge_id=c.id LEFT JOIN mt5_account_deliveries td ON td.challenge_id=c.id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE cp.status='paid' AND c.status IN ('pending','active') AND (td.id IS NULL OR td.email_status IN ('pending','failed')) ORDER BY cp.paid_at ASC LIMIT 100"
        ).all();
        return json({ challenges: rows.results });
      }

      const provisionMatch = url.pathname.match(/^\/api\/admin\/challenges\/([a-f0-9-]+)\/provision$/i);
      if (provisionMatch && request.method === 'POST') {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureMT5DeliveryTable(env.DB);
        const challengeId = provisionMatch[1];
        const challenge = await env.DB.prepare("SELECT c.id,c.status,u.id AS user_id,u.email,c.initial_balance AS account_size_usd FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id JOIN crypto_payments cp ON cp.challenge_id=c.id WHERE c.id=? AND cp.status='paid' AND c.status IN ('pending','active')").bind(challengeId).first();
        if (!challenge) return json({ error: 'Paid challenge not found.' }, 404);
        const oldDelivery = await env.DB.prepare('SELECT * FROM mt5_account_deliveries WHERE challenge_id=?').bind(challengeId).first();
        if (oldDelivery) {
          if (oldDelivery.email_status === 'sent') return json({ ok: true, provisioned: true, email_status: 'sent', message: 'Credentials email was already sent.' });
          const account = await env.DB.prepare('SELECT account_login,server_name FROM trading_accounts WHERE challenge_id=?').bind(challengeId).first();
          if (!account?.account_login) return json({ error: 'A delivery record exists but the MT5 account mapping is missing. Manual reconciliation is required; no email was sent.' }, 409);
          const mail = await sendMT5CredentialsEmail(env, challenge, account, oldDelivery);
          return json({ ok: mail.ok, provisioned: true, email_status: mail.ok ? 'sent' : 'failed', message: mail.ok ? 'MT5 credentials email sent on retry.' : 'Email retry failed; the delivery remains available for another retry.' }, mail.ok ? 200 : 502);
        }
        const providerUrl = String(env.MT5_PROVIDER_API_URL || '');
        if (!providerUrl || !env.MT5_PROVIDER_API_KEY || !env.RESEND_API_KEY || !env.MT5_EMAIL_FROM || !env.CREDENTIALS_ENCRYPTION_KEY) return json({ error: 'Configure MT5_PROVIDER_API_URL, MT5_PROVIDER_API_KEY, RESEND_API_KEY, MT5_EMAIL_FROM and CREDENTIALS_ENCRYPTION_KEY as Worker runtime secrets/variables first. No account was created.' }, 503);
        let endpoint; try { endpoint = new URL(providerUrl); } catch { return json({ error: 'Invalid MT5 provider URL.' }, 503); }
        if (endpoint.protocol !== 'https:') return json({ error: 'MT5 provider endpoint must use HTTPS.' }, 503);
        const accountSlot = await env.DB.prepare('SELECT id FROM trading_accounts WHERE challenge_id=?').bind(challengeId).first();
        if (!accountSlot) return json({ error: 'Trading account mapping is missing for this challenge. No provider request was sent.' }, 409);
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
      const cancelChallengeMatch = url.pathname.match(/^\/api\/admin\/challenges\/([a-f0-9-]+)\/cancel$/i);
      if (cancelChallengeMatch && request.method === "POST") {
        const denied = requireAdmin(session); if (denied) return denied;
        const challengeId = cancelChallengeMatch[1];
        const challenge = await env.DB.prepare("SELECT id,user_id,status FROM challenges WHERE id=?").bind(challengeId).first();
        if (!challenge) return json({ error: "Challenge not found." }, 404);
        if (!["pending","active"].includes(challenge.status)) return json({ error: "Only pending or active challenges can be cancelled." }, 409);
        const result = await env.DB.batch([
          env.DB.prepare("UPDATE challenges SET status='cancelled',ended_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('pending','active')").bind(challengeId),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'challenge',?,?)").bind(id(),session.user_id,"challenge.cancelled",challengeId,JSON.stringify({previous_status:challenge.status})),
          env.DB.prepare("INSERT INTO notifications (id,user_id,title,body) VALUES (?,?,?,?)").bind(id(),challenge.user_id,"Challenge cancelled","Your challenge has been cancelled by NEXFUND administration.")
        ]);
        const updated = await env.DB.prepare("SELECT status FROM challenges WHERE id=?").bind(challengeId).first();
        if (!updated || updated.status !== "cancelled") return json({ error: "Challenge state changed; cancellation was not applied." }, 409);
        return json({ ok:true, status:"cancelled", message:"Challenge cancelled and recorded in audit log." });
      }

      if (url.pathname === "/api/admin/programs" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureDefaultPrograms(env.DB);
        const rows = await env.DB.prepare("SELECT id,name,description,account_size_usd,fee_usd,profit_target_pct,daily_drawdown_pct,max_drawdown_pct,min_trading_days,max_trading_days,status,rules_json,created_at,updated_at FROM evaluation_programs ORDER BY account_size_usd ASC").all();
        return json({ programs: rows.results });
      }

      const adminProgramMatch = url.pathname.match(/^\/api\/admin\/programs\/([a-zA-Z0-9_-]+)$/);
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
        let programRules; try { programRules = JSON.parse(existing.rules_json || '{}'); } catch { programRules = {}; }
        const trailing = body.trailing_drawdown_pct === undefined ? (programRules.trailing_drawdown_pct ?? null) : (body.trailing_drawdown_pct === null || body.trailing_drawdown_pct === '' ? null : Number(body.trailing_drawdown_pct));
        if (trailing !== null && (!Number.isFinite(trailing) || trailing <= 0 || trailing > 100)) return json({ error: 'Trailing drawdown must be null or between 0 and 100.' }, 400);
        if (trailing === null) delete programRules.trailing_drawdown_pct; else programRules.trailing_drawdown_pct = trailing;
        if (!name || name.length > 120 || description.length > 1000) return json({ error: "Name (1–120 characters) and description (maximum 1000 characters) are required." }, 400);
        if (![size,fee,target,daily,maximum,minDays].every(Number.isFinite) || size < 100 || size > 10000000 || fee < 0 || fee > 100000 || target <= 0 || target > 100 || daily <= 0 || daily > 50 || maximum <= 0 || maximum > 100 || minDays < 0 || minDays > 365 || !Number.isInteger(minDays) || (maxDays !== null && (!Number.isInteger(maxDays) || maxDays < minDays || maxDays > 365))) return json({ error: "Program values are outside allowed ranges." }, 400);
        if (!["draft","active","paused","archived"].includes(status)) return json({ error: "Invalid program status." }, 400);
        await env.DB.batch([
          env.DB.prepare("UPDATE evaluation_programs SET name=?,description=?,account_size_usd=?,fee_usd=?,profit_target_pct=?,daily_drawdown_pct=?,max_drawdown_pct=?,min_trading_days=?,max_trading_days=?,status=?,rules_json=?,updated_at=datetime('now') WHERE id=?")
            .bind(name,description,size,fee,target,daily,maximum,minDays,maxDays,status,JSON.stringify(programRules),programId),
          env.DB.prepare("INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'evaluation_program',?,?)")
            .bind(id(),session.user_id,"admin.program_updated",programId,JSON.stringify({name,account_size_usd:size,fee_usd:fee,profit_target_pct:target,daily_drawdown_pct:daily,max_drawdown_pct:maximum,min_trading_days:minDays,max_trading_days:maxDays,trailing_drawdown_pct:trailing,status}))
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

      const adminUserStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/status$/i);
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

      if (url.pathname === "/api/admin/challenges" && request.method === "GET") {
        await ensureChallengeSnapshotSchema(env.DB);
        const denied = requireAdmin(session); if (denied) return denied;
        const status = url.searchParams.get("status");
        const allowed = ["pending","active","passed","failed","cancelled"];
        if (status && !allowed.includes(status)) return json({ error: "Invalid challenge status filter." }, 400);
        const query = "SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.high_watermark,c.daily_start_equity,c.daily_start_date,c.trading_days_count,c.rules_snapshot_json,c.started_at,c.ended_at,c.failure_reason,c.created_at,u.email,p.name AS program_name,p.profit_target_pct,p.daily_drawdown_pct,p.max_drawdown_pct,p.min_trading_days,p.max_trading_days,p.rules_json,t.platform,t.integration_mode,t.connection_status,t.account_login,t.server_name,t.last_sync_at FROM challenges c JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id LEFT JOIN trading_accounts t ON t.challenge_id=c.id " + (status ? "WHERE c.status=? " : "") + "ORDER BY c.created_at DESC LIMIT 200";
        const rows = status ? await env.DB.prepare(query).bind(status).all() : await env.DB.prepare(query).all();
        const challenges=(rows.results||[]).map(row=>{const rules=resolveChallengeRules(row,row);return {...row,profit_target_pct:rules.profitTargetPct,daily_drawdown_pct:rules.dailyDrawdownPct,max_drawdown_pct:rules.maxDrawdownPct,min_trading_days:rules.minTradingDays,max_trading_days:rules.maxTradingDays};});
        return json({ challenges, limit: 200, filtered_status: status || null });
      }

      if (url.pathname === "/api/admin/risk-events" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        const challengeId = String(url.searchParams.get("challenge_id") || "").trim();
        const severity = String(url.searchParams.get("severity") || "").trim();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
        if (!Number.isInteger(limit)) return json({ error: "Limit must be an integer." }, 400);
        if (severity && !["info","warning","breach"].includes(severity)) return json({ error: "Invalid severity filter." }, 400);
        const filters = [];
        const bindings = [];
        if (challengeId) { filters.push("r.challenge_id=?"); bindings.push(challengeId); }
        if (severity) { filters.push("r.severity=?"); bindings.push(severity); }
        const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
        const rows = await env.DB.prepare("SELECT r.id,r.challenge_id,r.event_type,r.severity,r.message,r.metric_value,r.threshold_value,r.created_at,u.email,p.name AS program_name,c.status AS challenge_status FROM risk_events r JOIN challenges c ON c.id=r.challenge_id JOIN users u ON u.id=c.user_id JOIN evaluation_programs p ON p.id=c.program_id " + where + " ORDER BY r.created_at DESC LIMIT ?").bind(...bindings,limit).all();
        return json({ risk_events: rows.results, limit, filters: { challenge_id: challengeId || null, severity: severity || null } });
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

      if (url.pathname === "/api/admin/financial-ledger" && request.method === "GET") {
        const denied = requireAdmin(session); if (denied) return denied;
        await ensureCryptoPayments(env.DB);
        await ensurePayoutTables(env.DB);
        const [orderTotals, paymentTotals, payoutTotals, orders, payments, payouts] = await Promise.all([
          env.DB.prepare("SELECT currency,status,COUNT(*) AS count,COALESCE(SUM(amount_usd),0) AS amount FROM orders GROUP BY currency,status ORDER BY currency,status").all(),
          env.DB.prepare("SELECT status,COUNT(*) AS count,COALESCE(SUM(amount_usdt),0) AS amount FROM crypto_payments GROUP BY status ORDER BY status").all(),
          env.DB.prepare("SELECT status,COUNT(*) AS count,COALESCE(SUM(requested_amount_usd),0) AS amount FROM payout_requests GROUP BY status ORDER BY status").all(),
          env.DB.prepare("SELECT o.id,o.status,o.amount_usd,o.currency,o.payment_provider,o.provider_reference,o.created_at,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200").all(),
          env.DB.prepare("SELECT cp.id,cp.status,cp.amount_usdt,cp.txid,cp.created_at,cp.paid_at,u.email FROM crypto_payments cp JOIN users u ON u.id=cp.user_id ORDER BY cp.created_at DESC LIMIT 200").all(),
          env.DB.prepare("SELECT pr.id,pr.status,pr.requested_amount_usd,pr.tx_reference,pr.created_at,pr.updated_at,u.email,pr.challenge_id FROM payout_requests pr JOIN users u ON u.id=pr.user_id ORDER BY pr.created_at DESC LIMIT 200").all()
        ]);
        return json({
          generated_at: now(),
          accounting_policy: { revenue: "Only paid orders and paid crypto payments are confirmed receipts. USD and USDT are reported separately; no assumed exchange rate.", payouts: "Only paid payouts are completed disbursements. Approved payouts remain outstanding commitments; pending requests await review; rejected requests are excluded." },
          orders: { totals: orderTotals.results || [], records: orders.results || [] },
          crypto_payments: { totals: paymentTotals.results || [], records: payments.results || [] },
          payouts: { totals: payoutTotals.results || [], records: payouts.results || [] }
        });
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        const denied = requireAdmin(session);
        if (denied) return denied;
        const rows = await env.DB.prepare("SELECT id,email,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 100").all();
        return json({ users: rows.results });
      }

      const adminTraderMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminTraderMatch && request.method === "GET") {
        const denied = requireAdmin(session);
        if (denied) return denied;
        const userId = decodeURIComponent(adminTraderMatch[1]);
        await ensureCryptoPayments(env.DB);
        const user = await env.DB.prepare("SELECT id,email,role,status,email_verified_at,created_at,updated_at FROM users WHERE id=?").bind(userId).first();
        if (!user) return json({ error: "Trader not found." }, 404);
        const [challenges, payouts, payments, orders, risk, tradeStats, symbolStats, recentTrades] = await Promise.all([
          env.DB.prepare("SELECT c.id,c.status,c.initial_balance,c.current_balance,c.equity,c.trading_days_count,c.started_at,c.ended_at,c.created_at,p.name AS program_name,t.account_login,t.server_name,t.connection_status,(SELECT COUNT(*) FROM trade_events te WHERE te.challenge_id=c.id AND te.closed_at IS NOT NULL) AS trade_count,(SELECT COALESCE(SUM(te.profit+te.commission+te.swap),0) FROM trade_events te WHERE te.challenge_id=c.id AND te.closed_at IS NOT NULL) AS net_trade_pnl FROM challenges c JOIN evaluation_programs p ON p.id=c.program_id LEFT JOIN trading_accounts t ON t.challenge_id=c.id WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 100").bind(userId).all(),
          env.DB.prepare("SELECT id,challenge_id,requested_amount_usd,payout_wallet_address,status,admin_note,tx_reference,created_at,updated_at FROM payout_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(userId).all(),
          env.DB.prepare("SELECT id,challenge_id,amount_usdt,status,txid,created_at,paid_at FROM crypto_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(userId).all(),
          env.DB.prepare("SELECT o.id,o.status,o.amount_usd,o.currency,o.payment_provider,o.created_at,p.name AS program_name FROM orders o JOIN evaluation_programs p ON p.id=o.program_id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 100").bind(userId).all(),
          env.DB.prepare("SELECT r.id,r.challenge_id,r.event_type,r.severity,r.message,r.metric_value,r.threshold_value,r.created_at FROM risk_events r JOIN challenges c ON c.id=r.challenge_id WHERE c.user_id=? ORDER BY r.created_at DESC LIMIT 50").bind(userId).all(),
          env.DB.prepare("SELECT COUNT(*) AS closed_trades,SUM(CASE WHEN profit+commission+swap>0 THEN 1 ELSE 0 END) AS wins,SUM(CASE WHEN profit+commission+swap<0 THEN 1 ELSE 0 END) AS losses,COALESCE(SUM(profit+commission+swap),0) AS net_pnl,COALESCE(SUM(CASE WHEN profit+commission+swap>0 THEN profit+commission+swap ELSE 0 END),0) AS gross_profit,COALESCE(SUM(CASE WHEN profit+commission+swap<0 THEN -(profit+commission+swap) ELSE 0 END),0) AS gross_loss,AVG(CASE WHEN profit+commission+swap>0 THEN profit+commission+swap END) AS average_win,AVG(CASE WHEN profit+commission+swap<0 THEN profit+commission+swap END) AS average_loss,MAX(profit+commission+swap) AS best_trade,MIN(profit+commission+swap) AS worst_trade FROM trade_events te JOIN challenges c ON c.id=te.challenge_id WHERE c.user_id=? AND te.closed_at IS NOT NULL").bind(userId).first(),
          env.DB.prepare("SELECT te.symbol,COUNT(*) AS trades,COALESCE(SUM(te.profit+te.commission+te.swap),0) AS net_pnl,SUM(CASE WHEN te.profit+te.commission+te.swap>0 THEN 1 ELSE 0 END) AS wins FROM trade_events te JOIN challenges c ON c.id=te.challenge_id WHERE c.user_id=? AND te.closed_at IS NOT NULL GROUP BY te.symbol ORDER BY net_pnl DESC LIMIT 20").bind(userId).all(),
          env.DB.prepare("SELECT te.id,te.challenge_id,te.symbol,te.side,te.volume,te.open_price,te.close_price,te.profit,te.commission,te.swap,te.opened_at,te.closed_at,te.source FROM trade_events te JOIN challenges c ON c.id=te.challenge_id WHERE c.user_id=? AND te.closed_at IS NOT NULL ORDER BY te.closed_at DESC LIMIT 30").bind(userId).all()
        ]);
        const stats=tradeStats||{};
        const winCount=Number(stats.wins||0),lossCount=Number(stats.losses||0),closedCount=Number(stats.closed_trades||0);
        const analytics={closed_trades:closedCount,wins:winCount,losses:lossCount,win_rate_pct:closedCount?winCount/closedCount*100:0,net_pnl:Number(stats.net_pnl||0),gross_profit:Number(stats.gross_profit||0),gross_loss:Number(stats.gross_loss||0),profit_factor:Number(stats.gross_loss||0)>0?Number(stats.gross_profit||0)/Number(stats.gross_loss):null,average_win:stats.average_win===null?null:Number(stats.average_win||0),average_loss:stats.average_loss===null?null:Number(stats.average_loss||0),best_trade:stats.best_trade===null?null:Number(stats.best_trade||0),worst_trade:stats.worst_trade===null?null:Number(stats.worst_trade||0)};
        return json({ user, challenges: challenges.results||[], payouts: payouts.results||[], payments: payments.results||[], orders: orders.results||[], risk_events: risk.results||[], analytics, symbol_stats:symbolStats.results||[], recent_trades:recentTrades.results||[] });
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
async function ensurePayoutTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS payout_requests (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    requested_amount_usd REAL NOT NULL CHECK(requested_amount_usd>0),
    payout_wallet_address TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
    admin_note TEXT,tx_reference TEXT,reviewed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  const payoutColumns = await db.prepare("PRAGMA table_info(payout_requests)").all();
  if (!(payoutColumns.results || []).some(column => column.name === "payout_wallet_address")) {
    try { await db.prepare("ALTER TABLE payout_requests ADD COLUMN payout_wallet_address TEXT").run(); }
    catch (error) { const refreshed=await db.prepare("PRAGMA table_info(payout_requests)").all(); if (!(refreshed.results||[]).some(column=>column.name==="payout_wallet_address")) throw error; }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_payout_user_created ON payout_requests(user_id,created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_payout_status_created ON payout_requests(status,created_at)").run();
}
async function ensureNotificationTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,body TEXT NOT NULL,read_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id,created_at)").run();
}
async function ensureSupportTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('payment','account','challenge','technical','other')),
    subject TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS support_ticket_messages (
    id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_role TEXT NOT NULL CHECK(author_role IN ('trader','admin')),message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_support_tickets_user_updated ON support_tickets(user_id,updated_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_created ON support_ticket_messages(ticket_id,created_at)").run();
}
async function ensureSimulatorTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS simulator_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance REAL NOT NULL DEFAULT 10000, equity REAL NOT NULL DEFAULT 10000,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS simulator_trades (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES simulator_accounts(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity REAL NOT NULL CHECK(quantity>0),
    entry_price REAL NOT NULL CHECK(entry_price>0), exit_price REAL NOT NULL CHECK(exit_price>0),
    pnl REAL NOT NULL, status TEXT NOT NULL DEFAULT 'closed', created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sim_trades_user ON simulator_trades(user_id,created_at)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS simulator_positions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES simulator_accounts(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity REAL NOT NULL CHECK(quantity>0),
    entry_price REAL NOT NULL CHECK(entry_price>0), current_price REAL NOT NULL CHECK(current_price>0),
    stop_loss REAL, take_profit REAL, unrealized_pnl REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    exit_price REAL, realized_pnl REAL, close_reason TEXT,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sim_positions_user_status ON simulator_positions(user_id,status,opened_at)").run();
}
