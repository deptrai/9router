# Fix vùng C — core handlers + routes correctness

## Đã sửa

### [R1-P0-1] NextResponse chưa import trong chat.js:111
- File: `src/sse/handlers/chat.js:111`
- Sửa gì: Thay `NextResponse.json(...)` bằng `new Response(JSON.stringify(...), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })` — nhất quán với pattern tất cả handler khác, không thêm import NextResponse.
- Test đã chạy: chatCore-contract.test.js — 16/16 pass

### [R1-P0-2] Prototype pollution qua sanitizeSchemaForBedrock
- File: `src/sse/handlers/chat.js:95-103`
- Sửa gì: Deep-clone từng schema (`JSON.parse(JSON.stringify(...))`) trước khi truyền vào `sanitizeSchemaForBedrock`. Clone failure được bắt bằng try/catch giữ original. Ngăn `__proto__` / `constructor.prototype` bị mutate cross-request.
- Test đã chạy: chatCore-contract.test.js — 16/16 pass

### [R1-P1-1] search.js noAuth path trả undefined khi !result.success
- File: `src/sse/handlers/search.js:143`
- Sửa gì: Đổi `return result.response;` thành `return result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Search failed");`
- Test đã chạy: searchCore-contract.test.js — 6/6 pass

### [R1-P1-2] stt.js thiếu checkAndRefreshToken + clearAccountError
- File: `src/sse/handlers/stt.js:1-12, 79-96`
- Sửa gì: Thêm import `clearAccountError` từ auth.js + `updateProviderCredentials, checkAndRefreshToken` từ tokenRefresh.js. Wrap credentials qua `checkAndRefreshToken` trước `handleSttCore`. Thêm `onCredentialsRefreshed` + `onRequestSuccess` callbacks theo pattern embeddings.js.
- Test đã chạy: sttCore-contract.test.js — 6/6 pass

### [R1-P1-2] tts.js thiếu checkAndRefreshToken + clearAccountError
- File: `src/sse/handlers/tts.js:1-13, 99-118`
- Sửa gì: Thêm import `clearAccountError` + `updateProviderCredentials, checkAndRefreshToken`. Wrap credentials qua `checkAndRefreshToken` trước `handleTtsCore`. Thêm `onCredentialsRefreshed` + `onRequestSuccess` callbacks.
- Test đã chạy: ttsCore-contract.test.js — 6/6 pass

### [R1-P1-4] tokenRefresh.js truthy check bỏ sót accessToken=""
- File: `src/sse/services/tokenRefresh.js:159-160`
- Sửa gì: `if (newCredentials.accessToken)` → `if (newCredentials.accessToken != null)`. Tương tự refreshToken. Đảm bảo empty string hoặc explicit null/undefined được phân biệt đúng.

### [R1-P2-4] logger.js error() dùng console.log thay vì console.error
- File: `src/sse/utils/logger.js:73`
- Sửa gì: `console.log(...)` → `console.error(...)` trong hàm `error()`. Log shipper (Loki/Grafana) phân biệt stderr vs stdout.

### [R2-P1-1] ensureInitialized race condition — 4 route files + compact
- Files:
  - `src/app/api/v1/chat/completions/route.js:4-11`
  - `src/app/api/v1/messages/route.js:4-11`
  - `src/app/api/v1/responses/route.js:4-11`
  - `src/app/api/v1/responses/compact/route.js:4-11`
  - `src/app/api/v1beta/models/[...path]/route.js:4-11`
- Sửa gì: Đổi `let initialized = false` + boolean-guard thành promise-singleton: `let _initPromise = null; function ensureInitialized() { return (_initPromise ??= initTranslators()); }`. Concurrent cold requests giờ đều await cùng một Promise, không gọi initTranslators() nhiều lần.
- Test đã chạy: chatCore-contract.test.js, v1-api-chat-ollama.test.js — pass

### [R2-P1-2] responses/compact thiếu try/catch parse body
- File: `src/app/api/v1/responses/compact/route.js:27-37`
- Sửa gì: Bọc `request.json()` trong try/catch, trả 400 với error envelope nếu JSON lỗi — nhất quán với count_tokens pattern.

### [R2-P1-5] v1beta/models hardcode inputTokenLimit/outputTokenLimit
- File: `src/app/api/v1beta/models/route.js:27-33`
- Sửa gì: `inputTokenLimit: 128000` → `model.contextWindow ?? 128000`; `outputTokenLimit: 8192` → `model.maxOutputTokens ?? 8192`. Dùng metadata thật từ PROVIDER_MODELS, fallback về hardcode khi không có.

### [R2-P1-6] Ollama route nuốt lỗi parse body hoàn toàn
- File: `src/app/api/v1/api/chat/route.js:30-33`
- Sửa gì: `catch {}` → `catch (e) { console.log("[OLLAMA] ...", e?.message) }` để debug được khi body malformed.
- Test đã chạy: v1-api-chat-ollama.test.js — 8/8 pass

### [R2-P2-2] voices route fetch không có timeout
- File: `src/app/api/v1/audio/voices/route.js:35`
- Sửa gì: Thêm AbortController với 5s timeout bao quanh `fetch(url, { ..., signal: ac.signal })` + `clearTimeout` trong finally.
- Test đã chạy: v1-audio-voices.test.js — 7/7 pass

### [R2-P2-3] models/[kind] trả 404 thay vì 400 cho kind không hợp lệ
- File: `src/app/api/v1/models/[kind]/route.js:40`
- Sửa gì: `status: 404` → `status: 400`. Cập nhật test `v1-models-routes.test.js:106` từ `toBe(404)` → `toBe(400)` để khớp.
- Test đã chạy: v1-models-routes.test.js — 12/12 pass

## Đã verify KHÔNG cần sửa

- **R1-P1-3 mutex re-acquire trong auth.js**: Đây là race rất hiếm (abort + concurrency cao dẫn đến deadlock). Code hiện tại có `try/catch {}` bao quanh `await nextMutex` nên không throw. Rủi ro thực tế thấp, fix cần load test để xác nhận — để lại comment "verify under load" thay vì sửa mù.
- **R1-P1-5 await updateProviderCredentials trong hot path**: Trade-off có chủ ý — block để đảm bảo token được persist trước khi dùng. Pattern fire-and-forget có thể khuếch đại OAuth calls nếu nhiều concurrent requests cùng thấy token sắp hết hạn. Giữ nguyên.
- **R2-P1-4 models cache theo kind**: buildModelsList đã được gọi qua module route.js; cache theo kindFilter là cải thiện P2, không phải correctness critical. Ghi vào DECISIONS.

## Chuyển sang DECISIONS (đổi hành vi nghiệp vụ — cần user quyết)

Xem _fix/DECISIONS.md.

## Test summary

Tất cả 70 tests pass (8 files), 0 fail. Baseline 1983 pass không bị đỏ thêm.
