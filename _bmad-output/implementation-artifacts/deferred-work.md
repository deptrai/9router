## Deferred from: code review of story-1.3 (2026-09-10)

- Deceptive "idempotency" test uses static mock — `users.controller.spec.ts:191-198` calls `controller.getMe` twice with a static object literal mock. It proves only that JavaScript returns the same reference, not that DB upsert is idempotent under race conditions or state changes. Requires real DB test infrastructure or integration tests to fix meaningfully.
- Duplicate API route surface `/api/auth/me` and `/api/users/me` — `AuthService` is a hollow passthrough to `UserWalletService`. Both endpoints return identical shape with inconsistent parameter naming (`telegramUser` vs `user`). Requires architectural decision on whether to deprecate `/api/auth/me` or consolidate client routing.

## Deferred from: code review of 1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md (2026-09-10)

- Missing indexes on `ledgerTransactions` (wallet_id, reference_id, created_at) and no `currency` column — performance/auditing, not required by current ACs [packages/database/src/schema.ts]
- Held-balance ledger operations not implemented; reserved for checkout/order stories later [apps/api/src/modules/ledger/ledger.service.ts]

## Deferred from: code review of 2-3-tao-hoa-don-nap-tien-tu-dong-qua-bitcart-crypto (2026-09-10)

- `convertVndToUsd` dùng tỉ giá tĩnh và round down — `apps/api/src/modules/payments/payments.service.ts:164-169`. Cần rate oracle và chính sách làm tròn trong tương lai.
- Polling timeout 5 phút quá ngắn cho on-chain crypto — `apps/mini-app/src/app/topup/page.tsx:19`. Cấu hình lại khi có UX decision.
- Không có maximum top-up limit — `apps/api/src/modules/payments/payments.controller.ts:19-24`, `apps/mini-app/src/app/topup/page.tsx:140-145`. Rủi ro tài chính nhưng chưa có yêu cầu business.
- `resolveSettlement` là dead code — `apps/api/src/modules/payments/bitcart.service.ts:244-263`. Không được gọi, không gây lỗi.
- `normalizeContract` không tự thêm prefix `0x` cho EVM address — `apps/api/src/modules/payments/bitcart.service.ts:37`. Phụ thuộc định dạng contract từ Bitcart wallet.
- Thiếu QR code cho `payAddress` crypto — `apps/mini-app/src/app/topup/page.tsx:420-445`. UX improvement ngoài acceptance criteria.

- source_spec: `_bmad-output/implementation-artifacts/spec-fix-deferred-2-3.md`
  summary: Replace third-party api.qrserver.com with client-side canvas/SVG QR generator for crypto payAddress
  evidence: Privacy and SPOF risks with external QR image server; use local SVG/canvas QR generator instead
