---
baseline_commit: aebbca22131e7c29789efe7024825f5d40506491
epic: 1
---

# Story 1.6: Tối ưu thuật toán fallback khi Kiro 429 (rate-limit)

Status: ready-for-dev

## Story

As a **người dùng các model `kr/*` (đặc biệt `kiro/auto`, `claude-opus/sonnet-thinking-agentic`) trên 9Router có nhiều Kiro account**,
I want **proxy fail-fast khi một account bị 429 và xoay ngay sang account khoẻ khác, với cooldown backoff đúng với thời gian phục hồi thật của Kiro**,
so that **tỉ lệ request lỗi 429 nhìn từ client giảm mạnh, không bị "thrashing" (unlock quá sớm rồi 429 lại), và không lãng phí ~4s retry vô ích trên account đã hết quota**.

## Bối cảnh & Bằng chứng (đã verify qua phân tích kiến trúc + query DB local 2026-06-08)

Đây là story bảo trì/cải tiến đường proxy Kiro (tiếp nối 1.1–1.4), KHÔNG thuộc SaaS. Xuất phát từ một câu hỏi review: "Khi Kiro 429, hệ thống có thực sự fallback hay chỉ retry rồi bỏ cuộc?". Sau khi trace toàn bộ flow và đo dữ liệu thật, phát hiện:

### Phát hiện 1 — Retry 429 ngay trên cùng account là vô ích
`KiroExecutor.execute` (`open-sse/executors/kiro.js`) có vòng retry riêng dùng `retry: { 429: 2 }` (`open-sse/config/providers.js`). Khi upstream trả 429 (quota per-account đã cạn), retry **cùng account/endpoint** gần như chắc chắn 429 lại → tốn ~4s (2 lần × 2s `RETRY_CONFIG.delayMs`) trước khi trả lỗi lên tầng `handleSingleModelChat` để xoay account. Với rate-limit kiểu quota-per-account, retry tại chỗ không có giá trị.

### Phát hiện 2 — Backoff base quá ngắn so với thời gian phục hồi thật
`BACKOFF_CONFIG.base = 2000` (`open-sse/config/errorConfig.js`). Đo recovery gap thật (thời gian từ 429 → request success kế tiếp trên cùng connection+model) từ `requestDetails` local DB:

| Model | min gap | avg gap | max gap | mẫu |
|---|---:|---:|---:|---:|
| claude-opus-4.8-thinking-agentic | 1s | **29s** | 304s | 21 |
| claude-sonnet-4.6-thinking-agentic | 4s | **13s** | 21s | 3 |
| auto | — | 228s | — | 1 |

→ base=2s khiến account được unlock sau 2s trong khi thực tế cần 13–29s để hồi → 429 lại → lock lại (thrashing). Progression `2→4→8s` phí 2–3 level mới chạm vùng phục hồi thật.

### Phát hiện 3 — 429 tập trung gần như hoàn toàn ở Kiro
429 rate (local DB, 7 ngày): kiro/opus 28.6% (32/112), kiro/sonnet 38.5% (10/26), kiro/auto 63.6% (7/11). Codex chỉ 4% (gpt-5.5) và 0% (gpt-5.4-mini). → Tối ưu nên nhắm Kiro.

### Phát hiện 4 — Logic fallback Kiro→Kiro account ĐÃ ĐÚNG (không phải bug)
Trace `src/sse/handlers/chat.js:195–275`: vòng `while(true)` gọi `getProviderCredentials(provider, excludeConnectionIds, model)` → khi lỗi, `markAccountUnavailable()` set `modelLock_${model}` → nếu `shouldFallback` thì `excludeConnectionIds.add(connId)` + `continue` → lần sau lấy account khác chưa bị exclude/lock. Cơ chế đúng. Local DB chỉ có 1 Kiro account nên 100% traffic dồn vào 1 connection — đúng thiết kế, không phải lỗi. Production (`router.chainlens.net`) có ≥2 Kiro account → fallback thực sự có đất diễn.

### Phát hiện 5 — Account selection KHÔNG health-aware
`getProviderCredentials` (`src/sse/services/auth.js`) chọn theo `fill-first` (account priority cao nhất, đã sort) hoặc `round-robin` (theo `lastUsedAt`). Cả hai **không** ưu tiên tránh account vừa 429 — chỉ loại account đang còn `modelLock` active. Khi lock vừa hết hạn (cooldown ngắn), account vừa lỗi vẫn dễ bị chọn lại.

### Phát hiện 6 — Multi-process: in-memory state KHÔNG an toàn
9Router chạy multi-process (xác nhận từ chủ dự án). Mọi cache/circuit-breaker dạng `Map` in-memory sẽ không sync giữa các process → không được dùng làm nguồn sự thật. `modelLock_*` trong DB (`providerConnections`) đã là cơ chế cross-process đúng đắn; cache in-memory chỉ được phép dùng làm lớp giảm tải đọc với TTL rất ngắn, DB vẫn là source of truth.

### Đã xác minh không gây quota leak (cho Patch E)
`checkKeyQuota(apiKey, model)` (`src/lib/quota/keyQuota.js:41,91`) được gọi ở `chat.js:162` **sau khi resolve canonical model**; quota đếm theo canonical model (có `normalizeModelName` để khớp cross-provider dash/dot). Fallback cùng canonical model → quota tính chung (không leak); fallback sang model khác (vd `kiro/auto`→`codex/gpt-5.5`) → tính vào quota model đó, đúng kỳ vọng.

## Acceptance Criteria

1. **WHEN** một Kiro account trả 429, **THEN** `KiroExecutor` KHÔNG retry tại chỗ trên cùng account (retry 429 = 0) mà trả lỗi ngay để tầng routing xoay account. (Patch A)
2. **WHEN** retry 429 = 0 áp dụng cho Kiro, **THEN** các provider khác KHÔNG bị ảnh hưởng (retry config của provider khác giữ nguyên); thay đổi kèm comment giải thích lý do per-account-quota.
3. **WHEN** một Kiro account bị rate-limit và không có `resetsAtMs`/server hint, **THEN** cooldown dùng `BACKOFF_CONFIG.base = 8000` với progression 8→16→32→64s… (cap `max = 10 phút`), ôm đúng vùng recovery thật 13–29s. (Patch B)
4. **WHEN** upstream cung cấp `resetsAtMs`/precise reset, **THEN** giá trị đó vẫn override backoff (giữ nguyên ưu tiên hiện có trong `markAccountUnavailable`); thay đổi base KHÔNG được phá path này.
5. **WHEN** có ≥2 Kiro account và một account vừa lỗi trong vòng 60s gần nhất (theo `lastErrorAt` trong DB), **THEN** `getProviderCredentials` xếp account đó xuống cuối thứ tự ưu tiên (health-aware), chọn account khoẻ trước — nhưng vẫn chọn account "vừa lỗi" nếu đó là account khả dụng duy nhất. (Patch D)
6. **WHEN** tất cả account của một provider+model đang bị `allRateLimited`, **THEN** các request kế tiếp trong cùng process được fail-fast qua một negative-cache TTL ngắn (≤2s), tránh query DB lặp; cache là per-process, DB vẫn là source of truth (multi-process safe). Khi một account thành công trở lại, cache được xoá ngay. (Patch C)
7. **WHEN** người dùng opt-in một combo preset `kiro-auto-safe` (vd `[kiro/auto, codex/gpt-5.5]`), **THEN** combo system hiện có (`open-sse/services/combo.js`) xử lý fallback cross-provider khi tất cả Kiro account cạn quota — KHÔNG thêm path fallback cross-provider tự động (auto-magic) ở tầng handler. (Patch E — opt-in, tài liệu/preset)
8. Không thay đổi hành vi cho path non-Kiro, non-429; full unit suite xanh; thêm test cho từng patch A/B/D/C.

## Tasks / Subtasks

### Patch A — Bỏ retry 429 vô ích cho Kiro (AC#1, #2)
- [ ] **A1**: `open-sse/config/providers.js` → `kiro`: đổi `retry: { 429: 2 }` thành `retry: { 429: 0 }`, kèm comment: "429 = per-account quota; retry cùng account sẽ luôn 429 lại → để handleSingleModelChat xoay account thay vì burn ~4s ở đây."
- [ ] **A2**: Xác nhận `KiroExecutor.execute` (`open-sse/executors/kiro.js`) dùng `resolveRetryEntry(retryConfig[429])` → với `{429:0}` thì `maxRetries=0` → không retry, trả `{response,...}` ngay (đọc lại đoạn `while(true)` để chắc không có nhánh nào hardcode retry 429).
- [ ] **A3**: Test: 429 từ Kiro → `execute` trả về sau đúng 1 lần fetch, không delay. (mock `proxyAwareFetch`)

### Patch B — Recalibrate backoff (AC#3, #4)
- [ ] **B1**: `open-sse/config/errorConfig.js` → `BACKOFF_CONFIG`: `base: 2000 → 8000`, `max: 5*60*1000 → 10*60*1000`. Kèm comment dẫn số liệu recovery gap (avg opus 29s, max 304s).
- [ ] **B2**: Xác nhận `getQuotaCooldown` (`open-sse/services/accountFallback.js`) progression đúng: level1=8s, level2=16s, … cap 10min.
- [ ] **B3**: Xác nhận `markAccountUnavailable` (`src/sse/services/auth.js`) vẫn ưu tiên `resetsAtMs` trước backoff (path này KHÔNG đổi).
- [ ] **B4**: Test: (a) 429 không resetsAtMs, backoffLevel 0→1 → cooldown=8s; level tăng → 16/32s; (b) 429 có `resetsAtMs=now+1s` → cooldown≈1s (không phải 8s); (c) cap không vượt 10min.

### Patch D — Health-aware account selection (AC#5)
- [ ] **D1**: `src/sse/services/auth.js` → nhánh `fill-first`: thay `connection = availableConnections[0]` bằng ranking ưu tiên + penalty cho account có `lastErrorAt` < 60s (đẩy xuống cuối). Đọc `lastErrorAt`/`backoffLevel` từ `connection.data` (đã persist). Giữ tie-break theo `priority`.
- [ ] **D2**: Đảm bảo khi chỉ còn 1 account khả dụng (kể cả vừa lỗi) thì vẫn chọn nó (không loại bỏ — chỉ hạ ưu tiên).
- [ ] **D3**: (cân nhắc) Áp cùng nguyên tắc cho nhánh `round-robin`? Đánh giá: round-robin có ngữ nghĩa riêng (phân tải đều) — chỉ thêm penalty nếu không phá sticky logic. Ghi rõ quyết định.
- [ ] **D4**: Test: 2 account, A có `lastErrorAt` 10s trước + B sạch → chọn B; chỉ còn A → vẫn chọn A.

### Patch C — Negative cache fail-fast (AC#6, multi-process safe)
- [ ] **C1**: `src/sse/services/auth.js`: thêm `_allLockedCache = new Map()` (key=`${providerId}:${model||"__all"}` → expiresAt ms). Đầu `getProviderCredentials` (sau resolve providerId+model, chỉ khi `excludeSet.size===0`): nếu cache còn hạn → trả `{ allRateLimited:true, _cached:true, retryAfter, retryAfterHuman }` ngay.
- [ ] **C2**: Khi phát hiện `allRateLimited` (nhánh ~dòng 88): set cache `Math.min(now+2000, earliestLockUntil)`.
- [ ] **C3**: Khi chọn được connection thành công (trước return credentials): `_allLockedCache.delete(cacheKey)`.
- [ ] **C4**: Comment rõ: per-process cache, max staleness 2s, DB là source of truth → multi-process an toàn (mỗi process tự lệch tối đa 2s).
- [ ] **C5**: Test: 2 lần gọi liên tiếp khi all-locked → lần 2 trả `_cached:true` không chạm DB (spy `getProviderConnections`); sau khi unlock + success → cache xoá, lần sau query DB lại.

### Patch E — Combo preset opt-in (AC#7, KHÔNG auto-magic)
- [ ] **E1**: Tài liệu: hướng dẫn tạo combo preset `kiro-auto-safe = [kiro/auto, codex/gpt-5.5]` qua UI Combos (đã có sẵn cơ chế `handleComboChat`). KHÔNG viết code fallback cross-provider mới ở `chat.js`.
- [ ] **E2**: (tùy chọn) Seed sẵn preset gợi ý trong tài liệu/onboarding; xác nhận combo fallback đã tính quota/observability per-model đúng (combo gọi `handleSingleModelChat` cho từng model → mỗi model resolve canonical riêng).
- [ ] **E3**: Ghi rõ trade-off observability: response cuối mang nhãn model thực sự phục vụ (combo đã xử lý), không phải alias gốc.

### Phần F — Verify & regression
- [ ] **F1**: Chạy full unit suite từ `tests/` (`NODE_PATH=/tmp/node_modules`), đảm bảo 0 fail.
- [ ] **F2**: (PENDING DEPLOY) Sau deploy lên instance ≥2 Kiro account: đo lại 429 rate nhìn-từ-client + xác nhận khi account A 429 thì account B nhận request. Không chạy được trong dev (không có production DB access) — để mở.

## Dev Notes

### Trạng thái hiện tại các file sẽ sửa (đã đọc)
- `open-sse/config/providers.js` — `kiro.retry = { 429: 2 }`. Chỉ Kiro có override này; provider khác dùng `DEFAULT_RETRY_CONFIG` (429: {attempts:0}).
- `open-sse/config/errorConfig.js` — `BACKOFF_CONFIG = { base: 2000, max: 5*60*1000, maxLevel: 15 }`; `MAX_RATE_LIMIT_COOLDOWN_MS = 30*60*1000`; `ERROR_RULES` có `{status:429, backoff:true}`.
- `open-sse/services/accountFallback.js` — `getQuotaCooldown(level) = min(base * 2^(level-1), max)`; `checkFallbackError` map status/text → {shouldFallback, cooldownMs, newBackoffLevel}.
- `src/sse/services/auth.js` — `getProviderCredentials`: mutex, lọc `excludeSet` + `isModelLockActive`, strategy fill-first/round-robin; `markAccountUnavailable`: ưu tiên `resetsAtMs` > backoff, set `modelLock_${model}` + `backoffLevel`.
- `open-sse/executors/kiro.js` — `execute` vòng `while(true)` retry theo `resolveRetryEntry(retryConfig[status])`; 429=0 → không retry.
- `src/sse/handlers/chat.js` — vòng account fallback `while(true)` (dòng 195–275), `excludeConnectionIds` + `markAccountUnavailable` + `continue`.
- `open-sse/services/combo.js` — `handleComboChat` fallback theo từng model trong combo (đã dùng cho cross-provider).

### Ràng buộc CRITICAL
- **KHÔNG** dùng in-memory state làm nguồn sự thật (multi-process). Patch C cache chỉ là lớp giảm tải TTL ≤2s; DB `modelLock_*` là source of truth.
- **Giữ ưu tiên `resetsAtMs`** trong `markAccountUnavailable` — Patch B chỉ đổi nhánh "không có server hint".
- Patch A chỉ đụng `kiro` provider — KHÔNG generalize sang provider khác (tránh mất retry chính đáng cho transient 429 của provider tôn trọng `retry-after`).
- Patch D: account "vừa lỗi" bị **hạ ưu tiên**, KHÔNG bị loại — nếu là account khả dụng duy nhất vẫn phải chọn.
- Patch E: KHÔNG thêm path fallback cross-provider tự động ở handler — đó là policy của user qua combo (tránh duplication + surprise observability).
- Không đổi định dạng response/SSE; không đổi public API của `getProviderCredentials` (chỉ thêm field `_cached` nội bộ).

### Out of scope
- Cross-provider auto-fallback ngầm ở tầng handler (cố ý loại — dùng combo).
- Circuit breaker đầy đủ dạng service riêng (đã quyết định: tái dùng `modelLock_*` DB + negative cache thay vì thêm abstraction).
- Đo baseline production thật (cần access DB `router.chainlens.net`) — để mở ở F2.
- Health scoring nhiều chiều (latency/success-rate weighting) — Patch D chỉ làm 1 rule (penalty 60s); mở rộng sau khi có data production.

### References
- [Source: open-sse/config/providers.js#kiro] — retry 429 config
- [Source: open-sse/config/errorConfig.js#BACKOFF_CONFIG] — backoff base/max
- [Source: open-sse/services/accountFallback.js#getQuotaCooldown] — exponential backoff
- [Source: open-sse/services/accountFallback.js#checkFallbackError] — phân loại lỗi → fallback
- [Source: src/sse/services/auth.js#getProviderCredentials] — account selection (fill-first/round-robin)
- [Source: src/sse/services/auth.js#markAccountUnavailable] — set modelLock + backoff, ưu tiên resetsAtMs
- [Source: src/sse/handlers/chat.js] — vòng account fallback (195–275)
- [Source: open-sse/executors/kiro.js#execute] — retry loop Kiro
- [Source: open-sse/services/combo.js#handleComboChat] — fallback cross-model/provider
- [Source: src/lib/quota/keyQuota.js#checkKeyQuota] — quota theo canonical model (no leak)
- [Source: src/lib/quota/normalize.js#normalizeModelName] — khớp model cross-provider dash/dot
- [Source: docs/stories/1-4-kiro-maxtokens-usage-fix.md] — story Kiro trước đó (format + bối cảnh usage)

## Dev Agent Record

### Agent Model Used
(to be filled by dev agent)

### Debug Log References

### Completion Notes List

### File List

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story 1.6 từ phân tích kiến trúc fallback Kiro 429 (Winston review). Baseline `aebbca2`. 5 patch A–E + verify. Số liệu recovery gap từ local requestDetails DB. Status → ready-for-dev. |
