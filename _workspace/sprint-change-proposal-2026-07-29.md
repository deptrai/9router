# Sprint Change Proposal — 2026-07-29

## 1. Tóm tắt vấn đề / Change trigger

Người dùng (Vonic) yêu cầu flow **tự động hóa hoàn toàn** để onboard supplier Telegram bot và đưa sản phẩm lên shop Telegram `@router_chainlensbot`:

> "Chỉ cần nhập Telegram bot của supplier → nhận OTP trên web → mọi việc còn lại tự động đến khi product được đưa lên shop."

Đây là phạm vi mở rộng so với story `2-38.2` hiện tại (`telegram_bot_scraper` supplier adapter + auto-purchase). Hiện tại admin phải:
- Tự chạy `telegram-relay.js` ở local,
- Tự nhập `command` / `interactionSteps`,
- Tự tạo `markup rule`,
- Tự `Publish all variants` trên dashboard.

Mục tiêu mới: thu gọn toàn bộ thành một wizard trên web, chỉ cần bot username + số điện thoại Telegram + OTP, sau đó hệ thống tự:
1. Login MTProto session qua relay.
2. Tự động chat với supplier bot, khám phá menu / danh mục / sản phẩm.
3. Trích xuất tên, giá (VND), tồn kho, mô tả.
4. Tạo supplier source + products trong 9Router, tự động gộp product group theo tên.
5. Tạo default markup rule.
6. Tự động publish all variants → sản phẩm xuất hiện trên `@router_chainlensbot`.

## 2. Impact Analysis

### Epic impact
- **Epic I — External store / supplier integrations** bị ảnh hưởng trực tiếp.
- Story `2-38.2` vẫn cần hoàn thiện lõi auto-purchase / fallback, nhưng cần bổ sung story con `2-38.3` cho auto-onboard + auto-publish.
- Story `2-25` (Telegram user-linking / product catalog) bị ảnh hưởng gián tiếp: sản phẩm publish phải được bot shop liệt kê đúng; cần đảm bảo `isActive` + `isPublished` sau khi auto-publish.

### Artifact impact
- **PRD**: Cần cập nhật hoặc tạo tài liệu yêu cầu cho flow `2-38.3`.
- **Architecture**: Cần thêm component `SupplierOnboardingWizard` + API route `/api/store/suppliers/onboard/telegram` + `verify-otp` + background `catalogAutoDiscovery`.
- **UI/UX**: Dashboard `/dashboard/suppliers` cần wizard 4 bước: (1) nhập bot username + phone, (2) OTP, (3) mapping/review, (4) done.
- **Data model**: Có thể tái dụng `supplierSources` và `products`; cần thêm trạng thái `onboardingStatus` hoặc dùng `lastSyncError` hiện có.
- **Security**: Lưu MTProto session string trong `authEnc` (đã mã hoá), relay token trong env, OTP qua HTTPS.

### Technical impact
- Relay hiện chạy CLI; cần cho phép gọi login / catalog discovery từ server API.
- Cần xử lý `2FA/phone code` an toàn, không lưu OTP.
- Cần auto-parsing button text + product detail message để trích xuất `price`, `stock`, `description`.
- Cần idempotent: tránh duplicate products khi re-sync.

## 3. Recommended Approach

**Option chọn: Direct Adjustment — thêm story `2-38.3` vào Epic I.**

Lý do:
- Không cần rollback `2-38.2` (đã có relay + scraper, chỉ cần wrap lại).
- Không cần giảm scope MVP; đây là tính năng mở rộng đáng giá.
- Có thể tận dụng `botClient.js` / shop bot đã có từ story `2-25` để hiển thị sản phẩm.

Rủi ro: **Trung bình**. Khó khăn chính là parsing catalog đa dạng từ các supplier bot khác nhau; cần parser linh hoạt và fallback cho admin review.

Effort: **Medium–High** (ước 4–6 story points).

## 4. Detailed Change Proposals

### Story: `2-38.3` — Auto-onboard & auto-publish supplier Telegram bot

**OLD:** Không có story này.

**NEW:**
```
# 2-38.3: Auto-onboard Telegram supplier bot → auto-publish lên shop

As an admin,
I want to enter supplier bot username + phone + OTP on dashboard,
so that the system auto-login, discovers catalog, creates products, and publishes them to @router_chainlensbot without manual steps.

## Acceptance Criteria
- AC1: Wizard UI collects botUsername, phone, vndPerCredit.
- AC2: Server sends phone code via relay; UI collects OTP and verifies.
- AC3: On success, session is saved to supplier source authEnc.
- AC4: System auto-runs /products or /start interaction, discovers collections and product buttons.
- AC5: Parser extracts name, price (VND), stock, description from product detail messages.
- AC6: Catalog sync creates supplier source + products, groups by name, creates default markup rule (e.g. 10%).
- AC7: Auto-publish all variants (isActive=1, isPublished=1) so they appear in @router_chainlensbot.
- AC8: UI shows progress/result and allows manual review/cleanup.
- AC9: Security: OTP not stored; session encrypted; relay token in env.

## Tasks
- T1: API `POST /api/store/suppliers/onboard/telegram/start` (send phone code)
- T2: API `POST /api/store/suppliers/onboard/telegram/verify` (verify OTP, save session)
- T3: `catalogAutoDiscover` service in `telegramBotScraperAdapter`
- T4: `productParser` for supplier bot message templates
- T5: Auto-create default markup rule on first onboarding
- T6: Auto-publish group after catalog sync
- T7: Dashboard wizard UI
- T8: Tests (unit + e2e mock relay)
```

### PRD / Architecture cập nhật
- Thêm section trong PRD/epic I mô tả flow tự động hóa.
- Architecture: thêm `SupplierOnboardingOrchestrator` gọi relay, parser, catalog sync, publish.

## 5. Implementation Handoff

- **Scope classification: Moderate** — cần thêm story, UI, API, parser.
- **Route to:**
  - PM/Architect: duyệt PRD/story `2-38.3`.
  - Developer agent (Amelia / `bmad-quick-dev` hoặc `9r-core-implementer` + `9r-route-implementer`): implement.
  - Test architect (Murat / `bmad-tea`): test plan vì liên quan relay thật + nhiều parser.

## 6. Success Criteria
- Admin onboard `tongmmobot` chỉ bằng 3 bước UI.
- Sản phẩm xuất hiện trên `@router_chainlensbot` sau khi wizard hoàn tất.
- Re-sync định kỳ không tạo duplicate.
- OTP / session an toàn, không leak log.
