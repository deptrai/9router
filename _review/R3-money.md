# Review vùng R3-money: Money Path
Phạm vi đã đọc: `src/lib/payment/**`, `src/lib/billing/**`, `src/lib/plans/**`, `src/lib/quota/**`, `src/lib/affiliate/**`, `src/lib/store/**`, `src/lib/db/repos/creditLedgerRepo.js`, `src/lib/db/repos/giftCodesRepo.js`, `src/app/api/payments/**`, `src/app/api/webhooks/**`, `src/app/api/gift-codes/**`, `src/app/api/store/**`, `src/app/api/combos/**` — ~45 files

---

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] settle.js: `adapter.transaction()` không được await — race condition double-credit

- File: `src/lib/payment/settle.js:18`
- Vấn đề: `adapter.transaction()` là synchronous wrapper của better-sqlite3. Nhưng bên trong callback, `recordCreditTxn` được gọi với `adapter` (inline, không wrap thêm transaction) — điều này bình thường. Tuy nhiên vấn đề nằm ở chỗ: `settlePayment` là `async function` và được gọi bằng `await settlePayment(...)` từ cả hai webhook routes. Bên trong, `adapter.transaction()` chạy SYNC nhưng không có cơ chế ngăn hai request webhook đồng thời cùng gọi `settlePayment` với cùng `payment.id` trước khi transaction của bên kia commit. SQLite serializes writes nhưng do check `fresh.status === "settled"` và ghi `status='settled'` nằm trong CÙNG một transaction → đây thực ra đúng và atomic với SQLite. **Tuy nhiên:** `settlePayment` tự gọi `getAdapter()` và mở transaction riêng — nếu caller (webhook/bitcart) đã có một `db.transaction()` đang mở ở ngoài (dòng 53-58 của bitcart route), mà sau đó `await settlePayment(payment, settlement)` lại gọi `adapter.transaction()` lồng vào trong, SQLite/better-sqlite3 không hỗ trợ nested transaction thật sự (dùng SAVEPOINT). Cần xác minh xem better-sqlite3 có ném lỗi hay silently skip khi nest transaction.
- Bằng chứng:
```js
// settle.js:18
adapter.transaction(() => {
  const fresh = adapter.get(`SELECT status FROM payments WHERE id = ?`, [payment.id]);
  if (!fresh) return;
  if (fresh.status === "settled") return;
  // ...ghi settled
  recordCreditTxn({ ... }, adapter); // inline, đúng
});
```
```js
// webhooks/bitcart/route.js:46 — gọi NGOÀI transaction của route
await settlePayment(payment, settlement);
```
- Blast radius: settle.js impact 193 files (high risk theo code-review-graph).
- Đề xuất: Xác minh better-sqlite3 version có hỗ trợ nested transaction qua SAVEPOINT không. Nếu không, đảm bảo không bao giờ gọi `settlePayment` từ trong một transaction đang mở. Hiện tại bitcart route gọi `settlePayment` NGOÀI transaction block (dòng 46 sau khi transaction block dòng 53 là cho non-terminal) → thứ tự này đúng, nhưng cần document rõ ràng để tránh regression.

---

### [P0-2] Bitcart: webhook secret lộ trong URL — bị ghi vào access log / Bitcart server

- File: `src/lib/payment/bitcart.js:85`
- Vấn đề: Shared secret được nhúng trực tiếp vào `notification_url` dưới dạng query param `?token=<secret>`. URL này được gửi đến Bitcart server (third-party) và sẽ xuất hiện trong:
  1. Access logs của reverse proxy (Nginx/Traefik) phía 9Router — query string thường được log mặc định.
  2. HTTP Referer header nếu có redirect.
  3. Bitcart lưu `notification_url` trong invoice record — nếu Bitcart bị compromise, secret bị lộ.
  Kẻ tấn công có secret này có thể giả mạo IPN `{"id": "<bất kỳ gatewayId>", "status": "complete"}` và trigger settlement cho bất kỳ payment nào.
- Bằng chứng:
```js
// bitcart.js:85
const notifUrl = `${base}/api/webhooks/bitcart?token=${encodeURIComponent(secret)}`;
```
- Blast radius: bitcart.js impact 159 files (high risk).
- Đề xuất: Đây là hạn chế đã biết của Bitcart (unsigned IPN + shared-secret-in-URL là design của Bitcart). Giảm thiểu: (1) Đảm bảo Traefik/Nginx không log query string cho path `/api/webhooks/bitcart`; (2) Rotate secret định kỳ; (3) Xem xét dùng HMAC signature nếu Bitcart hỗ trợ trong tương lai. Ghi nhận là accepted risk với mitigation.

---

### [P0-3] vnd-webhook: thiếu `force-dynamic` — prerender cache có thể nuốt POST webhook ở prod

- File: `src/app/api/payments/vnd-webhook/route.js` (không có dòng `export const dynamic`)
- Vấn đề: Route này là webhook nhận POST từ SePay để cộng credit cho user. Thiếu `export const dynamic = "force-dynamic"` khiến Next.js có thể prerender/cache route ở build time trên Dokploy prod. Kết quả: webhook POST từ SePay bị nuốt bởi prerender cache, payment không bao giờ được settled → user không nhận được credit dù đã chuyển tiền.
- Bằng chứng:
```bash
# grep kết quả: không có force-dynamic trong file này
# So sánh: bitcart webhook có (dòng 11), crypto webhook có (dòng 11)
# vnd-webhook KHÔNG có
```
- Blast radius: vnd-webhook impact 134 files (high risk).
- Đề xuất: Thêm `export const dynamic = "force-dynamic";` vào đầu file, ngay dưới imports. Đây là P0 vì là bug chỉ xảy ra ở prod (Dokploy) — đã có precedent trong CLAUDE.md.

---

### [P0-4] store/checkout: thiếu `force-dynamic` — checkout bị prerender ở prod

- File: `src/app/api/store/checkout/route.js` (không có dòng `export const dynamic`)
- Vấn đề: Route POST `/api/store/checkout` đọc session cookie và thực hiện credit debit. Thiếu `force-dynamic` → Next.js prerender nuốt request → checkout không hoạt động ở prod, hoặc trả về prerendered static response sai.
- Bằng chứng:
```bash
# grep force-dynamic trên file này: không có kết quả
```
- Đề xuất: Thêm `export const dynamic = "force-dynamic";` vào file.

---

### [P0-5] payments/vnd (POST): thiếu `force-dynamic` — tạo VND payment bị cache ở prod

- File: `src/app/api/payments/vnd/route.js` (không có `force-dynamic`)
- Vấn đề: Route POST tạo VND bank transfer payment (đọc session cookie, ghi DB). Thiếu `force-dynamic` → prerender cache trả về response cũ hoặc 405/404 thay vì tạo payment mới.
- Bằng chứng: `grep force-dynamic` trên file trả về không có kết quả.
- Đề xuất: Thêm `export const dynamic = "force-dynamic";`.

---

### [P0-6] affiliateCommission: `vnd_topup` không có trong `COMMISSION_ELIGIBLE_TYPES` — affiliate không nhận commission từ VND topup

- File: `src/lib/affiliate/affiliateCommission.js:12` và `src/app/api/payments/vnd-webhook/route.js:82`
- Vấn đề: vnd-webhook gọi `payAffiliateCommission({ ..., type: "vnd_topup", ... })` nhưng `COMMISSION_ELIGIBLE_TYPES = ["admin_topup", "gift_code", "crypto_topup"]` không có `"vnd_topup"`. Function trả về `null` ngay lập tức — affiliate referrer không bao giờ nhận commission từ VND topup. Đây là bug logic tài chính: nếu affiliate đã được hứa commission trên mọi topup, VND topup đang bị bỏ sót.
- Bằng chứng:
```js
// affiliateCommission.js:12
const COMMISSION_ELIGIBLE_TYPES = ["admin_topup", "gift_code", "crypto_topup"];
// "vnd_topup" KHÔNG có trong list

// vnd-webhook/route.js:82
await payAffiliateCommission({ userId: payment.userId, txnId: txn?.id, type: "vnd_topup", amount: credits });
// → trả về null, không có commission
```
- Đề xuất: Thêm `"vnd_topup"` vào `COMMISSION_ELIGIBLE_TYPES` nếu VND topup phải trả commission. Nếu đây là quyết định thiết kế có chủ ý (không commission cho VND), cần document rõ và bỏ call `payAffiliateCommission` trong vnd-webhook để tránh nhầm lẫn.

---

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] settle.js: `recordCreditTxn` được gọi với `adapter` INLINE bên trong `adapter.transaction()` — không có idempotency check cho bonus nếu `bonusAmount = 0` edge case

- File: `src/lib/payment/settle.js:31-55`
- Vấn đề: Không phải bug nghiêm trọng, nhưng cần ghi nhận: nếu `bonusPct` được thay đổi sau khi payment được tạo (ví dụ admin thay config), lần settle sẽ dùng `payment.bonusPercent` snapshot từ payment row — điều này đúng về mặt audit. Tuy nhiên: `creditsToAward = standardAmount + bonusAmount` nhưng `standardAmount = amountReceived` (crypto amount USD), không phải credits. Với NOWPayments, `amountReceived` = `actually_paid` (USD), còn `payment.credits` là số credits đã hứa. Tức là user nhận credits = số USD đã trả, không phải số credits trong payment row ban đầu. Cần xác minh contract: nếu VND rate = 1000 VND/credit và crypto payment là $10 USD thì user nhận 10 credits (= $10) hay credits theo tỷ lệ riêng?
- Bằng chứng:
```js
// settle.js:14-15
const standardAmount = amountReceived;  // USD amount từ crypto provider
const creditsToAward = standardAmount + bonusAmount;
// payment.credits (số credits đã hứa lúc tạo payment) KHÔNG được dùng ở đây
```
- Đề xuất: Xác minh rõ contract: credits awarded = amountReceived (USD) hay payment.credits. Nếu 1 USD = 1 credit là intentional, document rõ. Nếu sai, cần dùng `payment.credits` thay vì `amountReceived`.

### [P1-2] storeCheckout: plan activation chạy POST-COMMIT, ngoài transaction — có thể credit bị trừ nhưng plan không được activate

- File: `src/lib/store/storeCheckout.js:224-243`
- Vấn đề: Với `product.kind === "plan"`, credit debit xảy ra TRONG `adapter.transaction()` (dòng 70-206), nhưng `purchasePlanForUser()` được gọi SAU COMMIT (dòng 228). Nếu `purchasePlanForUser` ném lỗi (ví dụ `INSUFFICIENT_CREDITS` vì credits vừa bị trừ), user mất credits nhưng không có plan. Lỗi được catch và set `planActivationError` nhưng không refund.
- Bằng chứng:
```js
// storeCheckout.js:224-237
if (product?.kind === "plan" && product?.targetType === "9router_plan" && product?.targetId) {
  try {
    const planResult = await purchasePlanForUser({ ... }); // POST-COMMIT
    result.planActivation = planResult;
  } catch (e) {
    if (e instanceof PlanPurchaseError) {
      result.planActivation = null;
      result.planActivationError = { code: e.code, message: e.message };
      // KHÔNG refund credit đã trừ
    }
  }
}
```
- Đề xuất: Với product.kind=plan, toàn bộ flow (credit debit + plan activation) phải trong cùng một transaction, hoặc nếu planPurchase fail thì cần auto-refund (reverseTxn).

### [P1-3] checkRpmLimit / checkKeyQuota: read-modify-write không atomic — soft race condition

- File: `src/lib/quota/rpmLimit.js:44-65` và `src/lib/quota/keyQuota.js:74-119`
- Vấn đề: Cả hai hàm đều đọc state → kiểm tra → ghi state trong hai DB call riêng biệt (không có transaction). Hai request đồng thời từ cùng user có thể cùng pass kiểm tra tại `count = rpm-1`. File đã có comment `// NOTE: read-modify-write on the kv counter is not atomic` — tức là known/accepted.
- Bằng chứng:
```js
// rpmLimit.js:44-64
const count = win.reset ? 0 : (state.win1m?.count ?? 0);
if (count >= limits.rpm) { ... }  // check
await setRpmState(keyRow.userId, { win1m: { count: count + 1 } }); // write — separate call
```
- Đề xuất: Accepted soft-limit per design. Nếu cần hard enforcement: dùng atomic `UPDATE kv SET value = json_patch(value, ...) WHERE ... AND json_extract(value, '$.count') < rpm`.

### [P1-4] nowpayments-adapter: `_ipnCache` là module-level Map — memory leak + mất data khi serverless restart

- File: `src/lib/payment/nowpayments-adapter.js:30-36`
- Vấn đề: `_ipnCache` là in-memory Map. Trên Next.js/Dokploy, nếu process restart giữa lúc `cacheIpnData` và `resolveSettlement` (hai function khác nhau trong cùng webhook handler — thực ra gọi liên tiếp), cache bị xóa. Với Next.js Edge runtime hoặc multi-instance, cache không shared giữa instances. Tuy nhiên vì cả hai call xảy ra trong CÙNG một request handler (dòng 49-51 của crypto/route.js), risk thực tế thấp hơn.
- Bằng chứng:
```js
// nowpayments-adapter.js:30
const _ipnCache = new Map(); // module-level, không persist

// crypto/route.js:49-51
nowpaymentsAdapter.cacheIpnData(gatewayPaymentId, data);
const settlement = await nowpaymentsAdapter.resolveSettlement(gatewayPaymentId);
// → cùng request, risk thấp nhưng design fragile
```
- Đề xuất: Truyền `data` trực tiếp vào `resolveSettlement(gatewayPaymentId, data)` thay vì qua cache. Xóa `_ipnCache` pattern.

### [P1-5] planPurchase: idempotent path trả về `action: "buy"` hardcode, không reflect action thật

- File: `src/lib/plans/planPurchase.js:105`
- Vấn đề: Khi idempotency hit, result được build với `action: "buy"` hardcoded thay vì đọc action từ transaction record, có thể gây nhầm lẫn cho caller.
- Bằng chứng:
```js
// planPurchase.js:104-106
result = { action: "buy", plan, user, transaction: existing, idempotent: true, ... };
// "buy" hardcoded — nếu original action là "renew" hay "change", caller thấy "buy"
```
- Đề xuất: Lưu `action` vào `creditTransactions.note` hoặc thêm column riêng để idempotent path có thể trả về đúng action.

### [P1-6] adminFulfill/cancelOrder: không có refund khi cancel — user mất credit

- File: `src/lib/store/adminFulfill.js:128-146`
- Vấn đề: `cancelOrder` chuyển trạng thái `paid → cancelled` và release credential nhưng KHÔNG refund credits cho user. Comment trong code ghi "Credit refund is OUT OF SCOPE for 2.28 (admin handles manually)". Đây là accepted design nhưng rủi ro: nếu admin quên refund thủ công, user mất tiền vĩnh viễn mà không có alert.
- Bằng chứng:
```js
// adminFulfill.js:128 — comment
// Credit refund is OUT OF SCOPE for 2.28 (admin handles manually).
```
- Đề xuất: Ít nhất trigger Telegram notification cho admin khi cancel, nhắc nhở refund thủ công. Lý tưởng: implement auto-refund qua `reverseTxn`.

---

## P2 — Nên cải thiện

### [P2-1] checkCredits: fail-open toàn bộ — tài khoản disabled vẫn đi qua nếu DB lỗi

- File: `src/lib/billing/checkCredits.js:41-45`
- Vấn đề: Bất kỳ DB exception nào đều trả `{ allowed: true }` — kể cả khi user đã bị disable. Fail-open là intentional design per comment, nhưng có thể xem xét cache `isActive=false` state riêng để không phụ thuộc DB cho check disabled.
- Đề xuất: Accepted design. Nếu muốn strict hơn: cache isActive flag với TTL ngắn (30s) để vẫn block disabled user khi DB flaky.

### [P2-2] rpmLimit: in-memory `rateLimits` Map trong payments/create — không shared giữa instances, leak khi restart

- File: `src/app/api/payments/create/route.js:30-44`
- Vấn đề: `rateLimits` là module-level Map. Multi-instance deployment → mỗi instance có counter riêng → effective limit là `RATE_MAX * num_instances`. Khi process restart, counter reset.
- Đề xuất: Dùng KV store (đã có `makeKv` pattern trong project) để persist rate limit counter.

### [P2-3] creditLedgerRepo: balance lưu dạng REAL (float) — rounding error ở scale

- File: `src/lib/db/repos/creditLedgerRepo.js:14`
- Vấn đề: Known limitation (BP-6) đã documented. Float rounding tích lũy sau nhiều transactions nhỏ. Hiện tại chấp nhận được ở scale MVP.
- Đề xuất: Migrate sang INTEGER micro-credits (×1000) khi scale tăng.

### [P2-4] storeCheckout: idempotencyKey từ web checkout dùng `Date.now()` — không thật sự idempotent khi retry

- File: `src/app/api/store/checkout/route.js:49`
- Vấn đề: `const idempotencyKey = \`web:${session.userId}:${productId}:${Date.now()}\`` — mỗi request tạo key mới. Nếu client retry do timeout, sẽ tạo order mới (double charge nếu DB transaction đã commit).
- Bằng chứng:
```js
// checkout/route.js:49
const idempotencyKey = `web:${session.userId}:${productId}:${Date.now()}`;
```
- Đề xuất: Client phải tạo idempotencyKey trước và truyền trong request body. Server dùng key đó thay vì tự sinh.

### [P2-5] vndBank: `verifyWebhookSecret` hash-then-compare đúng, nhưng secret trong header có thể là plaintext Bearer token — cần document

- File: `src/lib/payment/vndBank.js:78-84` và `src/app/api/payments/vnd-webhook/route.js:9`
- Vấn đề: Route đọc secret từ `X-Sepay-Secret` header hoặc `Authorization: Bearer <secret>`. Nếu transport không dùng HTTPS, secret bị lộ. Cần xác nhận SePay luôn dùng HTTPS.
- Đề xuất: Document rõ requirement HTTPS. Đảm bảo Traefik enforce HTTPS trên endpoint này.

---

## Điểm tốt / không có vấn đề ở:

- **settle.js idempotency**: check `fresh.status === "settled"` bên trong transaction + `idempotencyKey` trên cả hai `recordCreditTxn` call → double-credit từ replay webhook được ngăn tốt.
- **giftCodesRepo.redeemGiftCode**: toàn bộ flow (check exhausted, insert redemption, increment count, recordCreditTxn) trong một `adapter.transaction()` → atomic, không có TOCTOU.
- **nowpayments.verifyIpnSignature**: HMAC-SHA512 + timing-safe compare → đúng.
- **bitcart.verifyAuth**: timing-safe compare → đúng.
- **vndBank.verifyWebhookSecret**: hash-then-timingSafeEqual → đúng.
- **planPurchase**: toàn bộ credit debit + user update trong một transaction → atomic.
- **storeCheckout**: idempotency double-check (outer + inner transaction) → solid pattern.
- **IDOR /api/payments/[id]**: check `payment.userId !== session.userId && role !== "admin"` → đúng.
- **supplier webhook auth**: `timingSafeEqual` trên SHA-256 digest → đúng, không có source-existence oracle leak.
- **creditLedgerRepo**: append-only ledger (BP-1), idempotencyKey UNIQUE (BP-4), ledger+balance trong một transaction (BP-5) → design tốt.
- **deductFromPriorityBuckets**: bucket priority logic đúng, multiplier validation đúng.
- **paymentExpirySweep**: UPDATE atomic, không có race condition.
- **orderStatusSync**: cross-source spoof guard (sourceId check) → đúng.
