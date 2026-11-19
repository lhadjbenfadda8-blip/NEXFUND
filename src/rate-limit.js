// Privacy-preserving, database-backed rate limits for public authentication endpoints.
const DEFAULT_WINDOW_SECONDS = 900;

export async function checkAuthRateLimit(db, request, route, options = {}) {
  const limit = Math.max(1, Math.floor(Number(options.limit ?? 10)));
  const windowSeconds = Math.max(60, Math.floor(Number(options.windowSeconds ?? DEFAULT_WINDOW_SECONDS)));
  const nowMs = Number(options.nowMs ?? Date.now());
  const windowStart = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds;
  const ip = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    || "unknown";
  const keyMaterial = route + "|" + ip;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const keyHash = btoa(String.fromCharCode(...new Uint8Array(digest)));

  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key_hash TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
  )`).run();

  const row = await db.prepare(`INSERT INTO auth_rate_limits(key_hash,window_start,attempts)
    VALUES(?,?,1)
    ON CONFLICT(key_hash) DO UPDATE SET
      window_start=excluded.window_start,
      attempts=CASE WHEN auth_rate_limits.window_start=excluded.window_start
        THEN auth_rate_limits.attempts+1 ELSE 1 END
    RETURNING attempts,window_start`).bind(keyHash, windowStart).first();

  // Opportunistic cleanup keeps the table bounded without a separate scheduled job.
  if (windowStart % (24 * 60 * 60) < windowSeconds) {
    await db.prepare("DELETE FROM auth_rate_limits WHERE window_start < ?").bind(windowStart - 86400).run();
  }

  const allowed = Number(row?.attempts ?? 0) <= limit;
  const retryAfter = Math.max(1, windowSeconds - (Math.floor(nowMs / 1000) - windowStart));
  return { allowed, retryAfter, remaining: Math.max(0, limit - Number(row?.attempts ?? 0)) };
}

