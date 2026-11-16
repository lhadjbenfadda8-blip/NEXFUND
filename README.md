# NEXFUND

NEXFUND is being developed as a proprietary trading evaluation platform. It is not a retail broker. This repository currently contains a preview website and an initial API foundation.

## Current implementation

- Cloudflare Worker API in `src/`
- D1 schema in `database/schema.sql`
- PBKDF2 password hashing (310,000 SHA-256 iterations)
- Random opaque session cookies; only SHA-256 token hashes are stored
- Trader registration, login, logout and session lookup
- Trader dashboard and challenge read endpoints
- Admin overview and user listing (admin role must be granted manually)
- Deterministic evaluation/risk engine (no live MT5 connection)
- Payment processing and live MT5 are intentionally disabled

## Cloudflare setup

1. Create a Cloudflare D1 database named `nexfund-db`.
2. Apply `database/schema.sql` using the D1 console or Wrangler.
3. Copy the D1 database ID into `wrangler.toml` in place of `REPLACE_WITH_D1_DATABASE_ID`.
4. Deploy the Worker with Wrangler, or configure the Cloudflare build to use `src/index.js` and the D1 binding named `DB`.
5. Verify `GET /api/health` returns `{ "ok": true, "database": "connected" }`.

Do not expose database credentials or secrets in source control. The initial admin role must be assigned directly in D1 by the repository owner after creating their account, for example:
`UPDATE users SET role='admin' WHERE email='your-admin-email@example.com';`

## API

- `GET /api/health`
- `POST /api/auth/register` JSON: `{ "email": "...", "password": "at least 12 characters" }`
- `POST /api/auth/login` JSON: `{ "email": "...", "password": "..." }`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/dashboard` (authenticated)
- `GET /api/challenges` (authenticated)
- `GET /api/admin/overview` (admin)
- `GET /api/admin/users` (admin)

All money and risk rules are provisional configuration data. Do not accept real payments or offer live funded accounts until the operating, legal, payment and platform-provider requirements have been resolved.
