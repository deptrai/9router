# DECISIONS — hành vi nghiệp vụ cần user quyết định

Format: `[R?-P?-?] <vấn đề> — <lựa chọn + khuyến nghị>`

---

## [R2-P0-3] CORS `Access-Control-Allow-Origin: *` trên toàn bộ endpoint

**Vấn đề:** Tất cả 19 route file đều trả `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers: *` kể cả chat/completions, messages, responses — endpoint tốn credit. Bất kỳ trang web nào cũng có thể gọi cross-origin từ browser user đã đăng nhập.

**Lựa chọn:**
- A. Giữ nguyên `*` — hợp lý nếu 9router là public API intended để nhúng vào bất kỳ client nào (giống OpenAI API). Tiếp tục dựa vào API key để kiểm soát truy cập.
- B. Giới hạn origin về `ALLOWED_ORIGINS` env cho các endpoint tốn credit (chat, tts, images); giữ `*` cho `/v1/models` (public catalog). Cần update tất cả 15+ route file.

**Khuyến nghị:** Nếu 9router là private instance (internal tool / self-hosted), chọn B. Nếu là public SaaS API như OpenAI, giữ A. KHÔNG tự đổi vì có thể phá client hiện tại.

---

## [R2-P1-3] `/v1/models` và `/v1/models/[kind]` thiếu auth khi requireApiKey=true

**Vấn đề:** GET `/v1/models` không check `requireApiKey`. Response trả toàn bộ danh sách provider alias, custom model ID, combo name — information disclosure về cấu hình nội bộ.

**Lựa chọn:**
- A. Giữ public — `/v1/models` là catalog endpoint chuẩn OpenAI, không cần auth. Client cần biết model list trước khi có key.
- B. Thêm optional auth check: nếu `requireApiKey=true` thì `/v1/models` cũng yêu cầu key. Nhất quán với bảo mật toàn hệ thống.

**Khuyến nghị:** B nếu cấu hình provider là thông tin nhạy cảm (private instance). A nếu muốn tương thích hoàn toàn với OpenAI SDK client discovery flow.

---

## [R2-P1-4] Module-level cache `_modelsCache` không chia sẻ với `/v1/models/[kind]`

**Vấn đề:** `/v1/models/[kind]` gọi `buildModelsList` trực tiếp không có cache — mỗi request = 5 DB queries. Traffic cao → N×5 queries.

**Lựa chọn:**
- A. Extract cache sang module riêng (`modelsCache.js`) với key theo `kindFilter`, TTL 5 phút, dùng chung cho cả 2 route.
- B. Giữ nguyên — chỉ fix khi có performance issue thực tế trên production.

**Khuyến nghị:** A, nhưng là P2 không urgent. Thực hiện khi refactor models routes.

---

## [R2-P2-1] `count_tokens` dùng heuristic chars/4 — không có flag estimate

**Vấn đề:** `/v1/messages/count_tokens` trả `input_tokens` tính bằng `Math.ceil(totalChars / 4)`. Tiếng Việt/CJK có thể undercount 2-4x. Comment trong code thừa nhận "Rough estimate" nhưng response không có warning field.

**Lựa chọn:**
- A. Thêm `"estimate": true` vào response body để client biết số không chính xác.
- B. Giữ nguyên — client đọc OpenAI spec đã biết đây là estimate endpoint, không cần field thêm.

**Khuyến nghị:** A — thêm field không phá backward compat, giúp client Việt hoá tránh undercount.

---

## [R1-P1-3] auth.js mutex re-acquire sau _waitForSlot — deadlock tiềm ẩn khi abort + concurrency cao

**Vấn đề:** Nếu `_waitForSlot` reject trong khi `resolveMutex` đã bị set null, `finally { if (resolveMutex) resolveMutex(); }` không release mutex → deadlock toàn process. Race hiếm, cần load test để xác nhận.

**Lựa chọn:**
- A. Thêm `try/finally` riêng bao quanh đoạn `_waitForSlot` để đảm bảo mutex luôn được release.
- B. Để nguyên + thêm comment "verify under load test" — fix chỉ khi reproduced.

**Khuyến nghị:** A là an toàn hơn, nhưng cần đọc toàn bộ auth.js mutex flow (agent A đang lo auth) để không xung đột. Giao agent A quyết nếu muốn fix.

---

## [R3-P0-2] Bitcart webhook secret lộ trong URL query param

**Vấn đề:** `BITCART_WEBHOOK_SECRET` được nhúng vào `notification_url` dạng `?token=<secret>`. URL này được lưu trong Bitcart invoice record và xuất hiện trong access log của Traefik/Nginx. Kẻ có secret có thể giả mạo IPN để trigger settlement cho bất kỳ payment nào.

**Hạn chế thiết kế:** Đây là design của Bitcart (unsigned IPN + shared-secret-in-URL). Không thể xoá hoàn toàn mà không fork Bitcart hoặc bỏ Bitcart.

**Lựa chọn:**
- A. Accepted risk + mitigation ops: (1) Cấu hình Traefik không log query string cho path `/api/webhooks/bitcart` (`accessLog.filters` hoặc middleware strip-query-log); (2) Rotate `BITCART_WEBHOOK_SECRET` định kỳ (monthly); (3) Theo dõi Bitcart changelog cho HMAC signature support.
- B. Thêm IP allowlist middleware trên Traefik cho `/api/webhooks/bitcart` — chỉ cho phép IP của Bitcart server gọi vào. Giảm blast radius nếu secret bị lộ.

**Khuyến nghị:** A + B kết hợp. KHÔNG sửa code vì phụ thuộc Bitcart API. Cần action ops: cấu hình Traefik + rotate secret.

---

## [R3-P0-6] Affiliate commission cho `vnd_topup` — có nên trả hoa hồng không?

**Vấn đề:** `COMMISSION_ELIGIBLE_TYPES = ["admin_topup", "gift_code", "crypto_topup"]` không có `"vnd_topup"`. vnd-webhook gọi `payAffiliateCommission({ type: "vnd_topup", ... })` nhưng function trả về `null` ngay — affiliate không nhận commission từ VND topup.

**Lựa chọn:**
- A. Thêm `"vnd_topup"` vào `COMMISSION_ELIGIBLE_TYPES` — affiliate nhận commission (mặc định 10%) trên mọi VND topup. Nhất quán với crypto_topup.
- B. Giữ nguyên (không commission cho VND topup) + xoá call `payAffiliateCommission` trong vnd-webhook để tránh nhầm lẫn và silent no-op. Document rõ đây là intentional.

**Khuyến nghị:** Cần user xác nhận policy affiliate. Nếu affiliate program hứa commission trên mọi topup → A. Nếu VND topup là kênh internal/không trong chương trình affiliate → B. KHÔNG tự thêm vì ảnh hưởng trực tiếp đến tiền thật của affiliate.

---

## [R3-P1-1] settle.js: contract 1 USD = 1 credit cho crypto payment

**Vấn đề:** `standardAmount = amountReceived` (USD thực nhận từ NOWPayments). `payment.credits` (số credits đã hứa lúc tạo invoice) không được dùng trong settle. Nếu rate conversion là 1 USD = 1 credit thì đúng. Nếu có rate riêng (ví dụ 1 USD = 100 credits), user nhận sai số credits.

**Lựa chọn:**
- A. Giữ nguyên `standardAmount = amountReceived` — 1 USD = 1 credit là intentional design. Document rõ trong code.
- B. Dùng `payment.credits` (đã được tính đúng lúc tạo invoice) thay vì `amountReceived` làm số credits trao — tách biệt "số tiền nhận" và "số credits hứa".

**Khuyến nghị:** User xác nhận contract. Nếu hệ thống luôn dùng 1 USD = 1 credit → A + thêm comment. Nếu có rate riêng → B cần thiết để tránh mất credits. KHÔNG tự đổi vì đây là formula tính tiền thật.

---

## [R3-P1-2] storeCheckout: plan activation fail sau commit — không có auto-refund

**Vấn đề:** Với `product.kind === "plan"`, credit debit xảy ra trong transaction, nhưng `purchasePlanForUser()` chạy post-commit. Nếu plan activation fail (ví dụ planId không tồn tại), credit đã bị trừ nhưng user không có plan. Lỗi được catch thành `planActivationError` nhưng không refund.

**Lựa chọn:**
- A. Implement auto-refund: khi `purchasePlanForUser` throw `PlanPurchaseError`, gọi `reverseTxn` để hoàn credit. Cần thêm `reverseTxn` function vào creditLedgerRepo (agent D).
- B. Giữ manual refund (admin xử lý) nhưng thêm Telegram alert khi `planActivationError` xảy ra, nhắc admin refund.
- C. Move plan activation vào trong transaction — nhưng `purchasePlanForUser` là async (gọi getAdapter riêng) nên cần refactor đáng kể.

**Khuyến nghị:** B ngắn hạn (alert admin), A dài hạn khi có reverseTxn. KHÔNG tự implement vì cần phối hợp với agent D (creditLedgerRepo).

---

## [R3-P1-6] adminFulfill cancelOrder — không có refund credit

**Vấn đề:** `cancelOrder` chuyển `paid → cancelled` và release credential nhưng không refund credits. Comment trong code: "Credit refund is OUT OF SCOPE for 2.28 (admin handles manually)." Nếu admin quên refund thủ công, user mất tiền vĩnh viễn.

**Lựa chọn:**
- A. Implement auto-refund khi cancel: gọi `reverseTxn` hoặc `recordCreditTxn` với amount dương cho user. Cần phối hợp agent D.
- B. Giữ manual + thêm Telegram notification cho admin khi cancel order, nhắc refund thủ công với amount cụ thể.

**Khuyến nghị:** B ngắn hạn (ít risk, không đổi money logic), A dài hạn. User xác nhận policy refund khi cancel.

---

## [R3-P2-4] storeCheckout: idempotencyKey dùng `Date.now()` — không thật sự idempotent khi retry

**Vấn đề:** `idempotencyKey = \`web:${userId}:${productId}:${Date.now()}\`` — mỗi request sinh key mới. Client retry do timeout → tạo order mới, có thể double charge nếu transaction đầu đã commit.

**Lựa chọn:**
- A. Client sinh idempotencyKey trước và truyền trong request body. Server dùng key đó thay vì tự sinh. Cần thay đổi client contract (frontend + API spec).
- B. Giữ nguyên — chấp nhận risk double charge khi retry, document rõ "client không được retry checkout request".

**Khuyến nghị:** A là đúng đắn về mặt kỹ thuật, nhưng cần đổi cả client (frontend) nên là breaking change. Cần user quyết định timeline và update frontend tương ứng. KHÔNG tự sửa server-side vì đổi API contract.

---

## [R5-P1-2] pollMitmHealth — rejectUnauthorized: false không thể tránh nhưng không verify pid

**Vấn đề:** Health check nội bộ dùng `rejectUnauthorized: false` (self-signed cert). Response trả `{ ok, pid }` — nếu port 443 bị process khác chiếm giữa kill và start, health check có thể báo thành công sai (nhưng pid sẽ khác `serverPid`).

**Lựa chọn:**
- A. Thêm kiểm tra `json.pid === serverPid` trong `pollMitmHealth` — từ chối nếu pid không khớp. Yêu cầu `/_mitm_health` trả pid (đã bị bỏ bởi R5-P1-5 loopback guard). Cần cân nhắc: trả pid cho loopback (internal check) nhưng ẩn pid với non-loopback.
- B. Giữ nguyên — risk thấp (loopback only, self-hosted context), không đáng đổi.

**Khuyến nghị:** A nếu muốn health check chính xác tuyệt đối. Cần phối hợp: `/_mitm_health` trả pid chỉ khi loopback, `pollMitmHealth` verify pid. KHÔNG tự sửa vì cần thay đổi cả server.js + manager.js theo cách phối hợp.

---

## [R6-P1-2] giftCodesRepo redeemGiftCode — nested transaction khi caller truyền db

**Vấn đề:** `redeemGiftCode({ db })` khi `db` là adapter đang trong transaction sẽ gọi `adapter.transaction()` lồng nhau — better-sqlite3 chỉ dùng savepoint, không phải nested transaction thật. Hiện tại không có caller nào truyền `db` vào `redeemGiftCode` (chỉ gọi từ Telegram bot không có outer txn), nên không có bug thực tế.

**Lựa chọn:**
- A. Refactor: nếu `db` truyền vào thì bỏ `adapter.transaction()` wrapper — chạy inline như pattern `recordCreditTxnWithAdapter`. Tách thành `_redeemGiftCodeSync(adapter)`.
- B. Giữ nguyên + thêm comment cảnh báo "KHÔNG gọi với db đang trong transaction". Safe vì không có caller hiện tại dùng pattern này.

**Khuyến nghị:** B ngắn hạn (zero risk hiện tại). A nếu cần tái sử dụng trong context transaction phức tạp hơn. KHÔNG tự refactor vì đây là money code — cần agent B (đang lo money flows) review đồng thời.

---

## [R6-P1-4] usageRepo deductFromPriorityBuckets — fail-open khi deduction lỗi

**Vấn đề:** Khi `deductFromPriorityBuckets` throw (DB lỗi, constraint violation), request vẫn được phục vụ nhưng credit không bị trừ. Fail-open là hành vi hiện tại (thiết kế UX — không từ chối request khi billing gặp lỗi kỹ thuật). Đã thêm log cảnh báo rõ để reconcile.

**Lựa chọn:**
- A. Giữ fail-open (hiện tại) — user không bị ảnh hưởng khi DB billing lỗi tạm thời. Reconcile qua log.
- B. Đổi thành fail-closed — nếu deduction lỗi, trả 500 cho user. Chặt chẽ hơn về tiền nhưng ảnh hưởng UX khi DB có transient error.

**Khuyến nghị:** Giữ A. Đây là quyết định nghiệp vụ — ưu tiên availability hay billing accuracy. Nếu đổi sang B cần thông báo user rõ và xử lý retry từ client.

---

## [R4-P1-7] OIDC callback — hardcode `role:"admin"` cho mọi OIDC user

**Vấn đề:** `src/app/api/auth/oidc/callback/route.js:80` hardcode `role: "admin"` cho tất cả OIDC login. Nếu OIDC provider cho phép self-register hoặc có nhiều user không phải operator, mọi OIDC account đều thành admin.

**Bối cảnh:** Comment trong code ghi rõ "OIDC is the operator sign-in path (not tied to a DB user row)" — tức là thiết kế hiện tại coi OIDC là single-tenant operator login, không phải multi-user. Nếu đây đúng là single-operator use case thì hardcode admin là intentional.

**Lựa chọn:**
- A. Giữ nguyên `role:"admin"` hardcode — tài liệu hoá rõ rằng OIDC provider PHẢI được cấu hình để chỉ cho phép đúng 1 operator account (email/domain allowlist ở phía provider). Trách nhiệm operator setup.
- B. Thêm email/domain allowlist check trong callback: so sánh `payload.email` với `ADMIN_EMAIL` env hoặc `OIDC_ALLOWED_EMAILS` env trước khi grant admin. Nếu không khớp → redirect về login với lỗi.
- C. Lấy role từ OIDC claim (ví dụ `groups`, `roles`) thay vì hardcode — flexible cho multi-tenant nhưng phức tạp hơn.

**Khuyến nghị:** B là cân bằng tốt — thêm 1 env check, không thay đổi luồng cho operator hợp lệ, chặn OIDC user lạ. Nhưng đây là đổi behavior (user OIDC không khớp `ADMIN_EMAIL` hiện đang pass → sẽ fail) → cần user quyết. KHÔNG tự sửa vì có thể phá OIDC login của operator hiện tại nếu họ không set `ADMIN_EMAIL` env.

---

## [R6-P1-7] validateBaseUrl — không chặn DNS rebinding / hostname private

**Vấn đề:** `validateBaseUrl` chặn IP private tốt nhưng không chặn hostname như `internal.corp` trỏ vào `10.x.x.x` (validate pass vì là hostname), và không chặn DNS rebinding (TOCTOU — validate lúc lưu, request gửi lúc runtime với IP khác).

**Lựa chọn:**
- A. Thêm DNS resolution tại thời điểm validate — resolve hostname, kiểm tra IP resolved có phải private không. Chậm hơn (~50-100ms), phụ thuộc DNS resolver.
- B. Dùng allowlist provider domain (firecrawl.dev, jina.ai, tavily.com, exa.ai) thay vì blocklist IP — chỉ cho phép known providers. Strict nhưng inflexible.
- C. Thêm network-level egress control (iptables/firewall rule chặn traffic từ Node process ra private ranges) — defense in depth không phụ thuộc code.

**Khuyến nghị:** C là đúng đắn nhất (network policy) nhưng cần ops setup. A khả thi cho validate-on-save. Với `/v1/web/fetch`, guard hiện tại (IP blocklist) là đủ cho 99% case — DNS rebinding phức tạp hơn và cần attacker kiểm soát DNS. Ghi nhận risk, không sửa thêm code vì cần infrastructure control.
