# Review vùng R2-routes: Route handlers v1 + v1beta
Phạm vi đã đọc: `src/app/api/v1/**/route.js` + `src/app/api/v1beta/**/route.js` — 19 file đọc đầy đủ. Core handler liên quan (`src/sse/handlers/fetch.js`, `search.js`, `imageGeneration.js`, `chat.js`, `tts.js`, `stt.js`, `embeddings.js`) và `open-sse/handlers/fetch/index.js`, `src/shared/utils/validateBaseUrl.js` đọc để xác minh finding.

---

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] `/v1/web/fetch` thiếu SSRF guard trên URL do user cung cấp

- **File:** `src/sse/handlers/fetch.js:74-79`
- **Vấn đề:** Validation URL chỉ kiểm tra format (`new URL(targetUrl)`) rồi chuyển thẳng `targetUrl` vào upstream providers (firecrawl, jina-reader, tavily, exa). Không có kiểm tra scheme, không chặn IP private, không dùng `validateBaseUrl`. Attacker gửi `url: "http://169.254.169.254/latest/meta-data/"` — provider upstream sẽ fetch metadata AWS/GCP và trả nội dung về client. Với jina-reader, URL còn được nhúng vào đường dẫn `https://r.jina.ai/${encodeURIComponent(url)}` — vẫn route qua server jina nhưng với firecrawl/tavily/exa, server upstream của họ fetch trực tiếp URL được cung cấp.
- **Bằng chứng:**
  ```js
  // fetch.js:73-79 — chỉ kiểm tra format
  try {
    new URL(targetUrl);
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }
  // sau đó targetUrl đi thẳng vào handleFetchCore → runFirecrawl/runTavily/runExa
  ```
  ```js
  // open-sse/handlers/fetch/index.js:131
  body: JSON.stringify({ url, formats: [fmt] })  // url chưa được lọc
  ```
  So sánh: `validateBaseUrl` ở `src/shared/utils/validateBaseUrl.js` đã có đầy đủ logic chặn private IP và metadata endpoint — nhưng **không được gọi** tại đây.
- **Blast radius:** Đây là endpoint công khai (`POST /v1/web/fetch`). Auth chỉ bật khi `settings.requireApiKey = true` (off by default). Khi đã vào `handleFetchCore`, không có tầng SSRF nào nữa.
- **Đề xuất:** Gọi `validateBaseUrl(targetUrl)` (đã có sẵn) ngay sau bước `new URL()`. Bổ sung chặn scheme `file:`, `javascript:`, `data:`.

---

### [P0-2] `/v1/messages/count_tokens` và `/v1beta/models` hoàn toàn bỏ qua auth

- **File:** `src/app/api/v1/messages/count_tokens/route.js` (toàn file), `src/app/api/v1beta/models/route.js` (toàn file), `src/app/api/v1beta/models/[...path]/route.js` (toàn file)
- **Vấn đề:** Ba endpoint này không đọc `settings.requireApiKey`, không gọi `extractApiKey`/`isValidApiKey`. Trong khi đó tất cả core handler khác (chat, embeddings, tts, stt, search, fetch, imageGeneration) đều có guard `if (settings.requireApiKey) { ... }`. Đây là lỗ hổng auth bypass: khi admin bật `requireApiKey`, client không cần key vẫn gọi được `/v1beta/models/{model}:generateContent` — tức là gửi được chat request đầy đủ qua Gemini adapter mà không auth.
- **Bằng chứng:**
  ```js
  // v1beta/models/[...path]/route.js:41-108
  export async function POST(request, { params }) {
    await ensureInitialized();
    // ... không có bất kỳ auth check nào ...
    const response = await handleChat(newRequest);  // handleChat CÓ auth check
    // nhưng handleChat nhận request.headers từ newRequest — bearer token gốc vẫn được forward
    // → nếu admin bật requireApiKey nhưng client không gửi key,
    //   handleChat sẽ chặn; tuy nhiên v1beta route không trả lỗi sớm
    // count_tokens:
  ```
  ```js
  // v1/messages/count_tokens/route.js:17-51
  export async function POST(request) {
    let body;
    try { body = await request.json(); } catch { ... }
    // tính token estimate thô — không có auth check nào
    return new Response(JSON.stringify({ input_tokens: inputTokens }), { ... });
  }
  ```
- **Blast radius (impact tool):** `src/app/api/v1beta/models/[...path]/route.js` impact radius 500+ nodes (high risk).
- **Đề xuất:**
  - `count_tokens`: thêm `extractApiKey` + `isValidApiKey` guard tương tự các handler khác.
  - `v1beta` routes: thêm auth guard trước `ensureInitialized()` hoặc delegate sang `handleChat` chỉ khi auth đã pass trước đó.

---

### [P0-3] CORS `Access-Control-Allow-Origin: *` trên mọi endpoint kể cả chat/completions

- **File:** `src/app/api/v1/chat/completions/route.js:19-27`, `src/app/api/v1/messages/route.js:19-27`, `src/app/api/v1/responses/route.js:13-21`, `src/app/api/v1/images/generations/route.js:3-11`, và toàn bộ 19 route file.
- **Vấn đề:** Tất cả route preflight OPTIONS và GET/POST response đều trả `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers: *`. Bất kỳ trang web nào cũng có thể gọi thẳng các endpoint tốn credit (chat, image gen, TTS) từ browser của user đã đăng nhập — kể cả khi `requireApiKey = true`, attacker chỉ cần lấy key của nạn nhân qua XSS rồi gọi cross-origin. Với các endpoint không cần auth (mặc định), đây là điều kiện đủ để abuse bất hạn chế.
- **Bằng chứng:**
  ```js
  // chat/completions/route.js:19-27
  export async function OPTIONS() {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"  // wildcard headers
      }
    });
  }
  ```
- **Đề xuất:** Với endpoint cần auth, giới hạn CORS origin về danh sách cho phép (`ALLOWED_ORIGINS` env). Wildcard chỉ hợp lý cho `/v1/models` (public read-only). `Access-Control-Allow-Headers: *` không thực sự cần thiết — chỉ cần `Authorization, Content-Type`.

---

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] Race condition trong `ensureInitialized()` — 4 route file bị ảnh hưởng

- **File:** `src/app/api/v1/chat/completions/route.js:4-14`, `src/app/api/v1/messages/route.js:4-14`, `src/app/api/v1/responses/route.js:4-14`, `src/app/api/v1beta/models/[...path]/route.js:4-14`
- **Vấn đề:** `initialized` là module-level boolean. Nếu hai request concurrent đến cùng lúc khi chưa init, cả hai đều thấy `initialized === false`, cùng gọi `initTranslators()` song song. `initTranslators()` có thể có side effect khi chạy hai lần (register translator hai lần, duplicate state). Không có promise guard.
- **Bằng chứng:**
  ```js
  let initialized = false;
  async function ensureInitialized() {
    if (!initialized) {         // ← hai request thấy false cùng lúc
      await initTranslators();  // ← cả hai đều gọi
      initialized = true;
    }
  }
  ```
- **Đề xuất:** Dùng promise singleton: `let initPromise = null; function ensureInitialized() { return (initPromise ??= initTranslators()); }`

---

### [P1-2] `/v1/responses/compact` parse body hai lần — request body bị consume

- **File:** `src/app/api/v1/responses/compact/route.js:27-37`
- **Vấn đề:** Route tự `await request.json()` để inject `_compact = true`, sau đó tạo `new Request(...)` mới với body đã serialize lại. Điều này hợp lệ về mặt kỹ thuật, nhưng nếu `request.json()` ném lỗi (malformed JSON) thì không có try/catch → unhandled exception trả về 500 thay vì 400. Các route tương tự (chat, messages, responses) đều không parse body ở tầng route — chỉ route này làm vậy mà thiếu error handling.
- **Bằng chứng:**
  ```js
  export async function POST(request) {
    await ensureInitialized();
    const body = await request.json();  // ← không có try/catch
    body._compact = true;
    const newRequest = new Request(request.url, { ... });
    return await handleChat(newRequest);
  }
  ```
- **Đề xuất:** Bọc `request.json()` trong try/catch và trả 400 nếu lỗi, giống pattern trong `count_tokens/route.js`.

---

### [P1-3] `/v1/models` và `/v1/models/[kind]` thiếu auth — leak danh sách provider/credentials info

- **File:** `src/app/api/v1/models/route.js:494-513`, `src/app/api/v1/models/[kind]/route.js:27-55`
- **Vấn đề:** Endpoint GET `/v1/models` không check auth kể cả khi `requireApiKey = true`. Response trả về danh sách model đầy đủ bao gồm provider alias, custom model ID, combo name — thông tin đủ để attacker enumerate cấu hình nội bộ (provider nào đang kết nối, model nào được bật). Đây là information disclosure.
- **Bằng chứng:**
  ```js
  export async function GET() {
    try {
      // không có requireApiKey check
      const data = await buildModelsList([LLM_KIND]);
      return Response.json({ object: "list", data }, { ... });
    }
  }
  ```
- **Đề xuất:** Cần xác minh ý định thiết kế — nếu 9router là private instance, thêm optional auth check. Nếu là public catalog, tài liệu hoá rõ ràng đây là public endpoint có chủ ý.

---

### [P1-4] Module-level cache `_modelsCache` trong `route.js` không được chia sẻ với `/v1/models/[kind]`

- **File:** `src/app/api/v1/models/route.js:12-13`, `src/app/api/v1/models/[kind]/route.js:1`
- **Vấn đề:** `_modelsCache` chỉ cache cho GET `/v1/models` (LLM kind). `/v1/models/[kind]` import `buildModelsList` và gọi trực tiếp mà không có cache — mỗi request đến `/v1/models/image`, `/v1/models/tts`, v.v. sẽ gọi `getProviderConnections()` + `getCombos()` + `getCustomModels()` + `getModelAliases()` + `getDisabledModels()` = 5 DB query. Với traffic cao, đây là N×5 queries cho endpoint không cần realtime.
- **Đề xuất:** Mở rộng cache theo `kindFilter` key, hoặc extract cache sang module riêng dùng chung.

---

### [P1-5] `/v1beta/models` trả hardcode `inputTokenLimit: 128000` và `outputTokenLimit: 8192` cho mọi model

- **File:** `src/app/api/v1beta/models/route.js:27-33`
- **Vấn đề:** Thay vì dùng metadata thực từ `PROVIDER_MODELS`, route hardcode limit giống nhau cho mọi provider và mọi model. Client dùng Gemini SDK sẽ tin vào số này và có thể gửi context vượt giới hạn thật của model.
- **Bằng chứng:**
  ```js
  models.push({
    name: `models/${provider}/${model.id}`,
    inputTokenLimit: 128000,   // ← hardcode, sai với nhiều model
    outputTokenLimit: 8192,    // ← hardcode
  });
  ```
- **Đề xuất:** Dùng `model.contextWindow` và `model.maxOutputTokens` từ `PROVIDER_MODELS` nếu có, fallback về hardcode.

---

### [P1-6] `/v1/api/chat` (Ollama adapter) clone request nhưng parse JSON trước khi forward

- **File:** `src/app/api/v1/api/chat/route.js:27-35`
- **Vấn đề:** Route clone request rồi parse JSON từ clone để lấy `modelName`, sau đó forward `request` gốc (chưa clone) vào `handleChat`. Điều này đúng — body chưa bị consume. Tuy nhiên nếu `clonedReq.json()` fail (malformed JSON), lỗi bị nuốt trong `catch {}` rỗng và `modelName` fallback về `"llama3.2"` — `transformToOllama` có thể trả response Ollama với tên model sai, không có log warning.
- **Bằng chứng:**
  ```js
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}  // ← nuốt lỗi hoàn toàn, không log
  ```
- **Đề xuất:** Thêm `catch (e) { log.debug(...) }` để dễ debug, hoặc để `handleChat` tự parse và extract model name sau.

---

## P2 — Nên cải thiện

### [P2-1] `count_tokens` tính token bằng heuristic `chars/4` — sai lệch lớn với tiếng không phải Latin

- **File:** `src/app/api/v1/messages/count_tokens/route.js:43-44`
- **Vấn đề:** `Math.ceil(totalChars / 4)` là approximation cho tiếng Anh. Tiếng Việt/CJK có thể 1-2 char = 1 token → undercount 2-4x. Response comment đã thừa nhận "Rough estimate" nhưng không có warning trong response body.
- **Đề xuất:** Thêm field `"estimate": true` vào response để client biết đây không phải số chính xác.

### [P2-2] `/v1/audio/voices` fetch nội bộ không có timeout

- **File:** `src/app/api/v1/audio/voices/route.js:35`
- **Vấn đề:** `fetch(url, { cache: "no-store" })` không có timeout/AbortController. Nếu internal voices API treo, request này treo theo — có thể exhaust Next.js worker.
- **Đề xuất:** Thêm `AbortController` với timeout ~5s.

### [P2-3] `/v1/models/[kind]` phản hồi 404 thay vì 400 cho kind không hợp lệ

- **File:** `src/app/api/v1/models/[kind]/route.js:35-43`
- **Vấn đề:** `status: 404` cho "Unknown model kind" — semantically nên là 400 (bad request), không phải 404 (not found).
- **Đề xuất:** Đổi thành `status: 400`.

### [P2-4] `fetchCompatibleModelIds` trong `/v1/models` không validate scheme của baseUrl với `http://` trong production

- **File:** `src/app/api/v1/models/route.js:81-138`
- **Vấn đề:** Gọi `validateBaseUrl(baseUrl)` trước khi fetch — đúng. Nhưng `validateBaseUrl` mặc định allow `http://` khi `NODE_ENV === "development"`. Nếu Dokploy không set `NODE_ENV=production` đúng, một compatible provider với `baseUrl: "http://169.254.169.254"` sẽ qua được validation.
- **Đề xuất:** Luôn pass `{ allowHttp: false }` tường minh trong production path, không rely vào env detection.

---

## Điểm tốt / không có vấn đề ở

- **Auth delegation pattern:** Tất cả handler nặng (chat, embeddings, tts, stt, search, fetch, imageGeneration) đều có `requireApiKey` guard nhất quán — chỉ bị thiếu ở 3 endpoint ngoại lệ đã liệt kê.
- **SSRF cho provider baseUrl:** `validateBaseUrl` tại `src/shared/utils/validateBaseUrl.js` được thiết kế tốt với block list IMDS + private range check — được dùng đúng trong `fetchCompatibleModelIds`.
- **Input validation cơ bản:** Tất cả endpoint đều validate JSON parse, missing required fields, và trả đúng HTTP status.
- **Timeout cho outbound fetch:** `fetchCompatibleModelIds` có AbortController 5s; fetch core (`open-sse/handlers/fetch/index.js`) có `tryFetch` với timeout configurable.
- **Fallback + credential rotation:** Pattern `while(true)` + `excludeConnectionIds` + lease release trong `finally` được áp dụng nhất quán ở imageGeneration, search, fetch.
- **`v1/route.js` và `v1/models/[kind]/route.js`:** Sạch, đúng delegation pattern.
