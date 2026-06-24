# Báo cáo tổng hợp review backend 9router

Ngày: 2026-06-24 | Phạm vi: toàn bộ `src/` backend (581 file) | 6 reviewer song song, mỗi P0 nổi bật đã verify đọc-code thật.

## Tổng quan số liệu
| Vùng | P0 | P1 | P2 |
|------|----|----|----|
| R1 core (src/sse) | 2 | 5 | 4 |
| R2 routes /v1 | 3 | 6 | 4 |
| R3 money | 6 | 6 | 5 |
| R4 auth | 7 | 8 | 5 |
| R5 network | 2 | 7 | 5 |
| R6 data | 2 | 7 | 6 |
| **Sau khử trùng lặp** | **~20 P0 riêng biệt** | ~37 | ~28 |

Trùng lặp chéo vùng đã gộp: SSRF `/v1/web/fetch` (R2-P0-1 = R5-P0-1); fail-open credit `saveRequestUsage` (R3 + R6-P1-4); nhóm thiếu `force-dynamic` (R3×3 + R5 web/fetch + R4 require-login).

---

## P0 — Phải sửa ngay (theo nhóm chủ đề)

### A. Auth bypass / quyền truy cập (R4 — vùng nặng nhất)
1. **`keys/route.js:18,56` — default role = "admin" khi không có session.** `session?.role ?? "admin"` → request chưa đăng nhập được coi là admin, list/tạo toàn bộ API key. (đã verify)
2. **`keys/[id]/route.js`, `keys/[id]/quota/route.js` — handler không có auth check nào** (quota: 0 match auth/role/session). Chỉ dựa middleware; khi `requireLogin=false` hoặc middleware miss → hở hoàn toàn.
3. **`providers/[id]/route.js` (GET/PUT/DELETE) — thiếu `requireAdmin`** (route cha có, route con quên) → ghi đè provider apiKey, xóa connection.
4. **`oauth/[provider]/exchange|poll` — không auth** → inject provider connection / token tùy ý vào DB.
5. **`settings/proxy-test` — SSRF khi requireLogin=false**; **`settings/require-login` — leak `tunnelUrl`/`tailscaleUrl`** không cần auth.
6. **`count_tokens` + `v1beta/models` (R2-P0-2) — bỏ qua auth** kể cả khi `requireApiKey=true`.

→ Gốc rễ chung: pattern `?? "admin"` (R4-P1-1 `getSessionRole`) và "tin middleware thay vì guard ở handler". Khuyến nghị: đổi fallback role thành `"guest"`/`null` + thêm guard ở từng handler nhạy cảm.

### B. SSRF (R2 + R5 xác nhận chéo)
7. **`/v1/web/fetch` không chặn IP nội bộ/metadata.** Chỉ validate `new URL()` cú pháp; `validateBaseUrl` (đã tồn tại `src/shared/utils/validateBaseUrl.js:49`) **không được gọi**. User (hoặc bất kỳ ai khi `requireApiKey=false`) đọc được `169.254.169.254`/internal qua firecrawl/tavily/exa/jina. (đã verify: route không có guard nào)
8. **Proxy pool URL user-controlled** (R5-P0-2) set thẳng vào `HTTP_PROXY` → route toàn bộ LLM traffic (kèm upstream key) qua proxy attacker. Đã gated admin-only nhưng thiếu validate scheme + audit.

### C. Money path (R3)
9. **Bitcart webhook secret nằm trong query string** `notifUrl=...?token=${secret}` (`bitcart.js:85`) → lộ trong access log/Bitcart server → giả mạo IPN credit tùy ý. (đã verify)
10. **3 route money thiếu `force-dynamic`**: `payments/vnd-webhook`, `store/checkout`, `payments/vnd` → prerender cache nuốt webhook/checkout ở prod Dokploy → **user mất tiền không nhận credit**. (đã verify: cả 3 đều force-dynamic=0)
11. **`affiliateCommission.js:12` — `vnd_topup` không trong `COMMISSION_ELIGIBLE_TYPES`** → affiliate không bao giờ nhận hoa hồng từ VND topup (vnd-webhook vẫn gọi `payAffiliateCommission` nhưng trả null).
12. **`settle.js:18` nested-transaction risk** — cần xác minh better-sqlite3 không nest; hiện gọi đúng thứ tự nhưng dễ regression.

### D. Đúng đắn / ổn định lõi (R1)
13. **`chat.js:111` dùng `NextResponse` chưa import** → nhánh "context too large" ném `ReferenceError` thay vì trả 400, handler trung tâm (blast radius 136 file). (đã verify)
14. **`chat.js:32-57` prototype pollution** — `sanitizeSchemaForBedrock` đệ quy trên `tool.input_schema` từ client, không guard `__proto__`/`constructor` → ô nhiễm prototype cross-request.

### E. Data layer (R6)
15. **`usersRepo.js:129` SQL injection-pattern** — `sortCol`/`sortOrder` nội suy thẳng vào SQL. Hiện an toàn nhờ ternary hardcode nhưng là tiền lệ nguy hiểm; whitelist tại repo, đừng tin caller.

---

## P1 — Quan trọng (chọn lọc, đầy đủ trong file từng vùng)
- **Fail-open money (R6-P1-4/R3):** `saveRequestUsage` bọc cả `deductFromPriorityBuckets` trong `try/catch` nuốt lỗi → user được phục vụ mà **không bị trừ credit** khi DB credit lỗi. (đã verify: usageRepo.js:246–309)
- **OIDC callback hardcode `role:"admin"`** cho mọi user (R4-P1-7) → privilege escalation nếu OIDC cho self-register.
- **Race `ensureInitialized()`** ở 4 route (R2-P1-1) — thiếu promise-singleton, `initTranslators()` chạy 2 lần.
- **STT/TTS thiếu `checkAndRefreshToken` + `clearAccountError`** (R1-P1-2) → token stale, account bị penalize vĩnh viễn.
- **`storeCheckout` plan-activation post-commit không refund** (R3-P1-2) → trừ credit nhưng không có plan.
- **`shutdown/route.js` `headers()` thiếu `await`** (R4-P1-4, Next 15) → endpoint luôn 401.
- **Command-injection / sudo-stdin newline** trong tunnel/mitm (R5-P1-3, P1-4); **MITM `/_mitm_health` lộ PID ra internet** (R5-P1-5).
- **`loginLimiter` tin `x-forwarded-for[0]`** (R4-P1-2) → bypass rate limit.
- **N+1 query trong `handleRefList` Telegram** (R6-P0-2/P1) — 20 query/lần, fuzzy note-match sai với tên đặc biệt.
- **`search.js:143` trả `undefined`** thay vì errorResponse (R1-P1-1).

## P2 — Nên cải thiện
CORS `*` + `Allow-Headers: *` trên 16 route v1 (R2-P0-3 → thực chất P1/P2 tùy mô hình bảo mật); balance lưu float (R3-P2-3); rate-limit/IPN cache in-memory mất khi restart; logger dùng `console.log` cho error; `count_tokens` heuristic sai non-Latin; voices fetch thiếu timeout. Chi tiết trong từng file `_review/R*.md`.

---

## Khuyến nghị thứ tự khắc phục
1. **Hôm nay (rò rỉ tiền + auth):** #1–#2 (default admin + keys no-auth), #9–#10 (Bitcart secret + force-dynamic money), fail-open credit. Đây là nhóm vừa dễ khai thác vừa mất tiền/lộ quyền.
2. **Tuần này:** #3–#8 (provider/oauth auth, SSRF web/fetch + proxy pool), #13–#14 (chat.js crash + prototype pollution).
3. **Backlog có kiểm soát:** #11–#12, #15, toàn bộ P1, rồi P2.

Báo cáo từng vùng đầy đủ (kèm trích code + đề xuất sửa): `_review/R1-core.md` … `_review/R6-data.md`. Rubric chung: `_review/_RUBRIC.md`.
