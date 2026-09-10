## Deferred from: code review of story-1.3 (2026-09-10)

- Deceptive "idempotency" test uses static mock — `users.controller.spec.ts:191-198` calls `controller.getMe` twice with a static object literal mock. It proves only that JavaScript returns the same reference, not that DB upsert is idempotent under race conditions or state changes. Requires real DB test infrastructure or integration tests to fix meaningfully.
- Duplicate API route surface `/api/auth/me` and `/api/users/me` — `AuthService` is a hollow passthrough to `UserWalletService`. Both endpoints return identical shape with inconsistent parameter naming (`telegramUser` vs `user`). Requires architectural decision on whether to deprecate `/api/auth/me` or consolidate client routing.

## Deferred from: code review of 1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md (2026-09-10)

- Missing indexes on `ledgerTransactions` (wallet_id, reference_id, created_at) and no `currency` column — performance/auditing, not required by current ACs [packages/database/src/schema.ts]
- Held-balance ledger operations not implemented; reserved for checkout/order stories later [apps/api/src/modules/ledger/ledger.service.ts]
