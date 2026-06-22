# Story: Kiro Headless API-Key Auth

Status: done

## Story

As a user who doesn't want to sign in via OAuth / SSO,
I want to use a long-lived Kiro (AWS CodeWhisperer) API key (`ksk_`),
so that I can chat with Kiro models without a browser-based auth flow.

## Acceptance Criteria

1. API key (`ksk_`) can be imported via POST /api/oauth/kiro/api-key
2. Key is validated by calling ListAvailableProfiles on CodeWhisperer
3. Connection is stored with authType="apikey", authMethod="api_key"
4. Chat endpoint sends `tokentype: API_KEY` header (AWS requirement)
5. API key connections prefer `.amazonaws.com` endpoints (kiro.dev rejects `ksk_` keys)
6. Usage quota tracker shows friendly message instead of AWS 403 error

## Implementation

### Files Created

- `src/app/api/oauth/kiro/api-key/route.js` — POST endpoint, validates key via ListAvailableProfiles, stores connection with 1-year expiry, CLI-token auth

### Files Modified

- `src/lib/oauth/services/kiro.js` — added `validateApiKey()` (+L305) + `listAvailableProfiles()` (+L332), profiles array empty → returns null instead of throw
- `open-sse/executors/kiro.js` — `buildHeaders()` sends `tokentype: API_KEY` for API keys; `getOrderedBaseUrls()` puts `.amazonaws.com` first; `buildUrl()` uses ordered list
- `src/shared/constants/providers.js:286` — added `"kiro"` to `USAGE_APIKEY_PROVIDERS`
- `open-sse/services/usage.js:757` — early return for `authMethod === "api_key"`, skips AWS endpoints

### Key Decisions

- **authType: "apikey"** (no underscore) — local convention differs from upstream's `"api_key"`
- **tokentype: API_KEY** header is mandatory — without it AWS returns 403 for `ksk_` credentials
- Endpoint ordering: `.amazonaws.com` hosts first — kiro.dev returns 403 for API key tokens
- ListAvailableProfiles may return empty profiles array — key is still valid for chat, proceed without profileArn
- Usage quota API not available for `ksk_` keys — AWS CodeWhisperer quota endpoints always reject them

## Dev Notes

- Key format: `ksk_` prefix, typically 40+ hex characters
- No refreshToken (long-lived bearer credential)
- Expiry set to 1 year to skip proactive refresh
- Ported from upstream `decolua/9router` commit `706e6513` (selective files only — full merge had 70+ conflicts)
- Quota tracker fix (usage.js) was added post-hoc, not from upstream

## Testing

```bash
# Import API key
DATA_DIR=/path/to/data node import-script.js --key ksk_xxx

# Chat
curl -X POST http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-9r-cli-token: <token>" \
  -d '{"model":"kr/claude-haiku-4.5","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## Review Findings

- [x] [Review][Decision] `validateApiKey` nuốt mọi lỗi qua `catch {}` — key sai/403 vẫn được lưu thành connection `active`, vi phạm AC2. Key Decision chỉ cho phép bỏ qua trường hợp empty-profiles, nhưng `catch {}` nuốt luôn lỗi `!ok` từ `listAvailableProfiles`. [src/lib/oauth/services/kiro.js:312-318] — **FIXED**: removed try/catch, let HTTP errors throw
- [x] [Review][Patch] `testApiKeyConnection` thiếu `case "kiro"` + key lưu ở `accessToken` chứ không phải `apiKey` → re-test connection luôn fail và lật `testStatus` thành `error` dù key chạy được [src/app/api/providers/[id]/test/testUtils.js:629,662] — **FIXED**: added case "kiro", reads from accessToken
- [x] [Review][Patch] `listAvailableProfiles`/`validateApiKey` bỏ qua tham số `region` — endpoint hardcode `us-east-1`, nhưng `region` user nhập vẫn được lưu vào `providerSpecificData.region` gây sai lệch [src/lib/oauth/services/kiro.js:332-333] — **FIXED**: endpoint now uses `${region}`
- [x] [Review][Patch] Nhánh fallback `else if (credentials.accessToken)` thiếu optional chaining trong khi nhánh trên dùng `credentials?.` → TypeError nếu `credentials` null [open-sse/executors/kiro.js:26] — **FIXED**: changed to `credentials?.accessToken`
- [x] [Review][Patch] Lỗi validation key (client error) trả về HTTP 500 thay vì 4xx [src/app/api/oauth/kiro/api-key/route.js:62-65] — **FIXED**: validation errors return 422

### Dismissed (noise / false positive)

- `buildUrl` bỏ `model`/`stream`: false positive — base.js:39-40 làm y hệt cho non-compatible providers
- Empty `quotas: {}` phá consumer: verified nhất quán, reachable đúng
- Route không có auth guard: nhất quán với các import route khác (codex, cursor, gitlab)
- Comment `USAGE_SUPPORTED_PROVIDERS` sai: `kiro` có trong cả 2 list, AC6 vẫn hoạt động
- Hardcode expiry 1 năm + `refreshToken: null`: chủ ý theo Key Decision (API key không refresh)
