# NEXFUND

NEXFUND is being developed as a proprietary trading evaluation platform. It is not a retail broker. This repository currently contains a preview website and an initial API foundation.

## Current implementation

- Cloudflare Worker API in `src/`
- D1 schema in `database/schema.sql`
- PBKDF2 password hashing (100,000 SHA-256 iterations; current implementation)
- Random opaque session cookies; only SHA-256 token hashes are stored
- Trader registration, login, logout and session lookup
- Database-backed per-IP limits on registration/login attempts (IP values are hashed before storage)
- Payout request flow captures and checksum-validates the trader's TRON (TRC20) destination wallet
- Trader dashboard and challenge read endpoints
- Admin overview and user listing (admin role must be granted manually)
- Deterministic evaluation/risk engine (no live MT5 connection)
- Payment processing and live MT5 are intentionally disabled
- Payout requests require a valid TRON Base58Check address; this is address-format validation only, not proof of wallet ownership

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

## MT5 account provisioning and credential email

The API includes a provider-agnostic provisioning adapter at
`POST /api/admin/challenges/{challenge_id}/provision`. It only accepts a
challenge whose USDT payment is confirmed and requires an administrator session.
The configured provider must implement the NEXFUND adapter contract:

- Accept HTTPS POST with a Bearer API key and an `Idempotency-Key` header.
- Accept JSON fields: `external_reference`, `brand`, `server_name`,
  `platform`, `account_type`, `balance`, `currency`, and `trader_email`.
- Return JSON fields: `login` (numeric string), `server`, `password`,
  and optionally `account_ref`.

Required Cloudflare Worker runtime settings (never commit secrets):
- `MT5_PROVIDER_API_URL` — provider's HTTPS provisioning endpoint.
- `MT5_PROVIDER_API_KEY` — provider API key (Secret).
- `RESEND_API_KEY` — Resend API key (Secret).
- `MT5_EMAIL_FROM` — verified sender address, e.g. an address on a domain verified with Resend.
- `CREDENTIALS_ENCRYPTION_KEY` — base64-encoded 32-byte random key (Secret).

The MT5 password is encrypted with AES-GCM before it is stored in D1 and is
decrypted only for email delivery. The email contains the account login,
server and password and clearly labels the balance as virtual/simulated.
Email delivery uses Resend. The endpoint is not operational until a compatible
MT5 provider and a verified sender domain are configured. Do not enable live
payments or advertise account delivery until the provider contract, account
creation, email delivery and failure/retry paths have been tested end-to-end.
