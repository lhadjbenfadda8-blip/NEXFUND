# NEXFUND System Audit & Development Plan

Audit basis: source files on `main` reviewed on 2026-11-19. This is a code-level audit, not a production certification.

## Verified baseline

- Cloudflare Worker serves static assets and API; D1 binding is configured in `wrangler.toml`.
- Authentication routes exist: register, login, logout, current-user. Password hashing uses PBKDF2-SHA256 with 100,000 iterations; session cookie is HttpOnly, Secure, SameSite=Lax, 7-day lifetime.
- Evaluation programs are inserted as provisional defaults; public/client text explicitly identifies pricing and rules as provisional.
- Challenge selection creates a pending challenge, a trading-account row in demo mode, audit log, and pending crypto payment.
- Crypto payment verification is disabled unless Worker configuration enables it. Verification checks confirmed TRC20 transfer, recipient, token contract, and exact amount, but this needs a concurrency/idempotency review before production use.
- Admin provisioning is dependent on an external MT5 account provider, email provider, and encryption key. It is not ready without those integrations.
- Risk engine evaluates supplied balance/equity snapshots only; it is not connected to a live trading feed or execution system.
- Trader portal is limited: authentication, provisional challenge selection, payment display/verification, challenge list and notifications.
- Admin portal is limited: paid-account provisioning queue. It is not a full company operations console.

## Release gates / do not represent as live

- No real-money trading, live broker connection, payout processing, or verified provider-backed trading execution is implemented in the reviewed files.
- Challenge pricing/rules are provisional. Payment verification and account provisioning remain configuration/provider-dependent.
- Do not enable customer payments or advertise live/funded accounts until payment verification, legal/provider eligibility, account execution, challenge/risk synchronization, and customer support flows are tested end-to-end.

## Target platform modules

1. Public website and program/rules pages
2. Trader identity, authentication, profile, sessions and security
3. Challenge catalog, purchase/order lifecycle, pricing and rule versioning
4. Payment records, verification, reconciliation, refunds/adjustments, idempotency
5. Account lifecycle and broker/provider adapter
6. Trading data ingestion, order/trade history and equity snapshots
7. Challenge state machine and rule engine
8. Risk engine (daily loss, overall loss, profit target, minimum days, reset boundaries)
9. Trader dashboard and analytics
10. Admin console (users, programs, orders, payments, accounts, risk, support, audit)
11. Notifications and support/ticketing
12. Security, observability, backups, abuse controls, and operational readiness

## Development sequence

### Phase 0 — Baseline audit (this document)
Map the existing code, dependencies, data model, current behavior, and blockers. Preserve existing work.

### Phase 1 — Core domain and lifecycle
Define explicit states and transitions for orders, payments, challenges, accounts, and risk events; add constraints and transactional/idempotent operations. Add tests for state transitions.

### Phase 2 — Admin operations
Build a proper admin navigation and management views for users, programs, orders, payments, account provisioning, challenge/risk status, and audit logs. Restrict all admin APIs server-side.

### Phase 3 — Trader experience
Build account overview, purchase/order history, challenge metrics, trade history, profile/security settings, notifications, and support.

### Phase 4 — Provider and trading data integration
Select and contract an eligible trading/account provider. Implement a documented adapter, authenticated callbacks or polling, data validation, account provisioning, and reliable sync. No fake data presented as live.

### Phase 5 — Risk and challenge engine
Connect verified provider data to rule calculations. Cover boundary cases, timezone/day rollover, equity vs balance, open positions, breach persistence, and pass/fail transitions with tests.

### Phase 6 — Payment readiness
Choose an eligible payment provider/method; implement secure verification, amount/currency/recipient checks, replay protection, reconciliation and exception handling. Keep payment activation off until tested and eligibility confirmed.

### Phase 7 — Security and release testing
Review access control, session lifecycle, CSRF/origin handling, rate limits, input validation, secrets, logs, backups, monitoring, accessibility, mobile layout and end-to-end test flows. Release only after all gates are passed.

## Definition of done

A feature is complete only when its API, data persistence, UI, permissions, error states, tests/verification, and documentation are connected and demonstrated. A screen or placeholder alone is not completion.
