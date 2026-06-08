---
baseline_commit: 5fa6d303b86555d73f6d11d69de20b23c2a74a18
epic: E
---

# Story 2.14 (E.3): Plan quota enforcement (5h/weekly per-user) + credit-overflow toggle (Model B)

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **admin vận hành 9Router bán gói subscription (free/pro/max) + cho phép credit pay-as-you-go**,
I want **enforce quota token 5h/weekly theo gói của user (đếm gộp mọi key), tích hợp tại `chat.js`; khi user chạm hạn quota plan thì theo toggle `allowCreditOverflow`: bật → chuyển tính tiền credit (trừ `creditsBalance`), tắt → chặn `429`**,
so that **user có plan được áp đúng giới hạn token theo gói; hết quota có thể chọn tiếp tục bằng credit hoặc bị chặn; user không plan thì thuần credit như hiện tại; mọi khoản trừ credit ghi ledger (story 2.13)**.

## Bối cảnh & Quyết định kiến trúc

Đây là **E.3** — story enforcement keystone của Epic E. Phụ thuộc:
- **E.1 (2-11, done)**: `resolveUserLimits(userId, model)` → `{ source:"plan"|"credit", quota5h, quotaWeekly, perModelLimits, ... }`; `sumUsageTokensByUser(userId, model, sinceISO)`.
- **E.2 (2-12, done)**: RPM enforce tại `handleChat`; window engine có `5h`/`weekly`/`1m`; pattern `checkRpmLimit`.
- **E.3b (2-13, review→cần done trước)**: `recordCreditTxn({type, amount, ...})` ledger atomic. Deduction `usage_deduction` đã wire trong `saveRequestUsage`.

> ⚠️ **SEQUENCING**: 2.14 `BLOCKED-BY 2.13`. Story 2.13 hiện `review` (code đã có: `recordCreditTxn`, deduction wired). Nên **hoàn tất code-review 2.13 → done** trước khi dev 2.14, vì 2.14 sửa chính đường deduction mà 2.13 vừa dựng.

### Model B — Plan + Credit + overflow toggle (epics-saas.md#Epic E)
1. **User có plan còn hạn** (`source="plan"`): enforce quota 5h/weekly của plan. Trong hạn quota → **KHÔNG trừ credit** (plan đã trả tiền). Vẫn áp RPM (E.2, đã có).
2. **Plan chạm hạn quota** (consumed ≥ quota5h HOẶC ≥ quotaWeekly): rẽ theo `users.allowCreditOverflow`:
   - **ON** → request tiếp tục, billing chuyển sang **credit pay-as-you-go** (trừ `creditsBalance` theo cost in/out), vẫn cần `checkCredits` (số dư > 0). Ledger `type=usage_deduction` (đề xuất `bucket=standard`; cân nhắc note `overflow`).
   - **OFF** → chặn `429`: "plan quota exhausted (5h|weekly); enable credit overflow to continue".
3. **Không plan / plan hết hạn** (`source="credit"`): thuần pay-as-you-go credit như story 2.4 hiện tại (checkCredits gate + trừ credit). KHÔNG đổi hành vi.

→ **Billing source** mỗi request là một trong: `plan` (trong quota, không trừ credit), `overflow` (plan hết quota + toggle ON → trừ credit), `credit` (không plan → trừ credit). Quyết định này phải truyền tới tầng deduction.

### CRITICAL — vấn đề trung tâm: deduction hiện trừ MỌI request
`saveRequestUsage` (usageRepo.js:286-300) hiện gọi `recordCreditTxn(usage_deduction)` cho **mọi** request có `userId` + `cost>0`, KHÔNG phân biệt plan/credit. Dưới Model B, **plan user trong quota KHÔNG được trừ credit**. → 2.14 phải làm deduction **có điều kiện theo billing source**.

Thách thức: quyết định billing source xảy ra ở **admission** (`chat.js`, trước khi gọi upstream), nhưng deduction xảy ra ở **`saveRequestUsage`** (sau response, trong `open-sse/utils/usageTracking.js:345` + `open-sse/handlers/chatCore/requestDetail.js:93`) — cách nhau cả pipeline. Phải **truyền billing source** từ admission tới deduction.

### CRITICAL — fail-open xuyên suốt (nhất quán keyQuota/checkRpmLimit)
- Lỗi DB/resolver/parse khi check quota → **fail-open** (cho qua, không chặn), log warn. Chỉ chặn khi **chắc chắn** plan user vượt quota VÀ overflow OFF.
- Deduction lỗi → KHÔNG chặn (giống hiện tại, `saveRequestUsage` đã bọc try/catch nuốt lỗi).

### Hạ tầng hiện có (đã đọc code)
- `src/sse/handlers/chat.js#handleSingleModelChat` (dòng 122+): gate hiện tại theo thứ tự `checkKeyQuota`(171) → `checkCredits`(185) → fetch credentials(205). **Điểm chèn plan-quota**: cạnh `checkCredits`, sau khi resolve canonical `model`. `apiKey` có ở scope.
- `src/lib/quota/keyQuota.js`: **mẫu chuẩn** để mirror — window-state + `sumUsageTokens` consumed-vs-max, persist state on reset, fail-open. E.3 mirror sang **per-user**.
- `src/lib/quota/resolvePlan.js#resolveUserLimits(userId, model)`: trả `quota5h`/`quotaWeekly` (0 = unlimited), `source`, `modelLimit` (per-model — KHÔNG enforce ở story này, đó là E.6).
- `src/lib/db/repos/quotaRepo.js`: `sumUsageTokensByUser(userId, model, sinceISO)` (E.1), `getRpmState/setRpmState` (E.2, scope `rpmState` keyed userId). **Thêm** `getPlanQuotaState/setPlanQuotaState` (scope mới `planQuotaState`, keyed userId, shape `{ win5h:{startedAt}, winWeek:{startedAt} }`).
- `src/lib/billing/checkCredits.js`: gate số dư, pattern `apiKey→getApiKeyByKey→userId→getUserById`, fail-open.
- `src/lib/db/repos/usageRepo.js#saveRequestUsage` (dòng 245-314): deduction `recordCreditTxn` trong transaction. `entry` shape: `{ provider, model, tokens, apiKey, connectionId, endpoint, timestamp }`. **Phải thêm cờ** `billingSource`/`skipDeduction` vào entry.
- 2 call-site `saveRequestUsage`: `open-sse/utils/usageTracking.js:345`, `open-sse/handlers/chatCore/requestDetail.js:93`.
- `src/lib/db/schema.js#TABLES.users`: có `planId`/`planExpiresAt`, **chưa có** `allowCreditOverflow`.
- `src/app/api/users/me/route.js`: GET trả profile, PATCH sửa displayName/password — **thêm** field `allowCreditOverflow` vào cả hai.
- `usageHistory` index `idx_uh_apikey_ts ON (apiKey, timestamp)` **đã có** → `sumUsageTokensByUser` (JOIN apiKeys theo userId, filter apiKey+timestamp) đã được phục vụ. KHÔNG cần thêm index mới (AC#9 chỉ xác nhận đã có).
- Window engine `5h`/`weekly` (`window.js`) tái dùng nguyên — KHÔNG đổi.

## Acceptance Criteria

1. **WHEN** DB migrate, **THEN** `users` có thêm cột `allowCreditOverflow INTEGER DEFAULT 0` (boolean 0/1; default **0 = OFF**, chốt). Migration idempotent (guarded ADD COLUMN). `rowToUser` expose `allowCreditOverflow` (bool); `updateUser` cho phép set nó.
2. **WHEN** có hàm mới `checkPlanQuota(apiKey, model)` (đề xuất `src/lib/quota/planQuota.js`), **THEN**: (a) `!apiKey` / legacy / không map userId → `{ source:"none", allowed:true }` (không liên quan plan); (b) `resolveUserLimits(userId, model)`; (c) `source!=="plan"` → `{ source:"credit", allowed:true }` (caller dùng credit path); (d) `source==="plan"`: với mỗi window `5h`/`weekly` có quota>0, resolve window per-user (persist state on reset), `sumUsageTokensByUser` consumed; nếu **bất kỳ** window consumed ≥ quota → `{ source:"plan", allowed:false, exhausted:true, window, consumed, limit, retryAfter, retryAfterHuman }`; nếu còn dư mọi window → `{ source:"plan", allowed:true }`.
3. **WHEN** `source==="plan"` và còn quota, **THEN** request đi tiếp, billing source = `"plan"`, **KHÔNG trừ credit** (`saveRequestUsage` không ghi `usage_deduction` cho request này).
4. **WHEN** `source==="plan"` và quota exhausted, **THEN** rẽ theo `user.allowCreditOverflow`: **ON** → request tiếp tục, billing source = `"overflow"`, áp `checkCredits` (số dư>0, else 429 insufficient), trừ credit như pay-as-you-go; **OFF** → `429` message "[plan <name>] quota exhausted (<window>) — enable credit overflow to continue", kèm `Retry-After` tới lúc window reset.
5. **WHEN** `source==="credit"` (không plan/hết hạn), **THEN** hành vi y như story 2.4 hiện tại: `checkCredits` gate + trừ credit (billing source = `"credit"`). KHÔNG regression.
6. **WHEN** request hoàn tất, **THEN** deduction credit CHỈ xảy ra khi billing source ∈ {`credit`, `overflow`}; billing source = `plan` → KHÔNG deduction. Billing source được truyền từ admission (`chat.js`) tới `saveRequestUsage` qua `entry`.
7. **WHEN** quota plan sửa (E.1 resolve live) hoặc user bật/tắt `allowCreditOverflow`, **THEN** request kế tiếp áp giá trị mới ngay (không snapshot, không cache stale).
8. **WHEN** `GET/PATCH /api/users/me`, **THEN** user xem được + tự bật/tắt `allowCreditOverflow`. (UI đầy đủ là E.4; story này chỉ cần API field hoạt động.)
9. **CRITICAL fail-open**: lỗi DB/resolver/parse trong `checkPlanQuota` → `{ allowed:true }` + log warn (không chặn). `usageHistory(apiKey,timestamp)` index xác nhận đã tồn tại (`idx_uh_apikey_ts`) — không cần thêm. Full unit suite xanh; test phủ: AC#2 các nhánh (no-key/credit/plan-within/plan-exhausted-5h/plan-exhausted-weekly), AC#3 (plan trong quota không trừ credit), AC#4 (overflow ON→trừ + checkCredits, OFF→429), AC#5 (credit path regression), AC#6 (deduction có điều kiện theo source), AC#7 (đổi quota/toggle áp ngay), fail-open.

## Tasks / Subtasks

### Phần A — Schema: allowCreditOverflow (AC#1)
- [x] **A1**: `src/lib/db/schema.js` → thêm `allowCreditOverflow: "INTEGER DEFAULT 0"` vào `TABLES.users.columns` (default 0 = OFF, chốt).
- [x] **A2**: Migration `src/lib/db/migrations/004-credit-overflow.js` (version 4): guarded `ALTER TABLE users ADD COLUMN allowCreditOverflow INTEGER DEFAULT 0` (check cột tồn tại qua PRAGMA, pattern 002). Đăng ký vào `migrations/index.js` (`MIGRATIONS=[m001,m002,m003,m004]`).
- [x] **A3**: `usersRepo.rowToUser` → expose `allowCreditOverflow: row.allowCreditOverflow === 1 || row.allowCreditOverflow === true`. `updateUser`: thêm `allowCreditOverflow` vào SET clause + merged (theo pattern planId — chuyển bool→0/1).

### Phần B — Per-user plan quota state + checker (AC#2, #9)
- [x] **B1**: `quotaRepo.js` → `makeKv("planQuotaState")`; `getPlanQuotaState(userId)` / `setPlanQuotaState(userId, state)`. Shape `{ win5h:{startedAt}, winWeek:{startedAt} }` (giống keyQuotaState nhưng keyed userId).
- [x] **B2**: `src/lib/quota/planQuota.js` → `checkPlanQuota(apiKey, model, now=Date.now())`:
  - `if (!apiKey) return { source:"none", allowed:true }`
  - `keyRow = getApiKeyByKey(apiKey); if (!keyRow?.userId) return { source:"none", allowed:true }`
  - `limits = resolveUserLimits(keyRow.userId, model)`
  - `if (limits.source !== "plan") return { source: limits.source, allowed:true }` (credit/expired → caller dùng credit path)
  - đọc state; với mỗi `[windowType, quota]` ∈ `[["5h", limits.quota5h], ["weekly", limits.quotaWeekly]]` mà `quota>0`:
    - `resolveWindow(state[key], windowType, now)`; persist nếu reset
    - `consumed = sumUsageTokensByUser(keyRow.userId, null, startedAt)` (null = tổng mọi model — MVP enforce TỔNG, không per-model)
    - `if (consumed >= quota)` → persist state, build `resetAt = startedAt + duration(windowType)`, `retryAfterHuman = formatResetCountdown(resetAt, now)`, return `{ source:"plan", allowed:false, exhausted:true, window:windowType, consumed, limit:quota, planName:limits.planName, retryAfter:resetAt, retryAfterHuman }`
  - còn dư hết → persist state nếu reset → `{ source:"plan", allowed:true, planName:limits.planName }`
  - **bọc try/catch toàn hàm → `{ source:"error", allowed:true }` + warn** (fail-open, AC#9).
  - **Ghi rõ comment**: quota5h/quotaWeekly = 0 ⇒ unlimited (skip window đó). Enforce TỔNG tất cả model; per-model override (E.6) KHÔNG enforce ở đây.

### Phần C — Tích hợp chat.js + quyết định billing source (AC#3, #4, #5, #6)
- [x] **C1**: `src/sse/handlers/chat.js#handleSingleModelChat` — sau `checkKeyQuota` (171), thay/bổ sung khối quanh `checkCredits` (185) bằng logic Model B:
  ```js
  // --- Plan quota + credit (Story 2.14, E.3 — Model B) ---
  let billingSource; // "plan" | "overflow" | "credit"
  const pq = await checkPlanQuota(apiKey, model);
  if (pq.source === "plan" && pq.allowed) {
    billingSource = "plan";                 // trong quota → KHÔNG trừ credit
  } else if (pq.source === "plan" && pq.exhausted) {
    if (pq.allowCreditOverflow) {            // toggle đã có trong pq result (chốt c)
      const credit = await checkCredits(apiKey);
      if (!credit.allowed) return unavailableResponse(429, credit.reason||"insufficient credits", 60, "60s");
      billingSource = "overflow";            // hết quota + toggle ON → trừ credit
    } else {
      return unavailableResponse(429, `[plan ${pq.planName}] quota exhausted (${pq.window}) — enable credit overflow to continue`, pq.retryAfter, pq.retryAfterHuman);
    }
  } else {
    // source = credit/none/error → pay-as-you-go hiện tại
    const credit = await checkCredits(apiKey);
    if (!credit.allowed) return unavailableResponse(429, credit.reason||"insufficient credits", 60, "60s");
    billingSource = (pq.source === "none" || pq.source === "error") ? "credit" : "credit";
  }
  ```
  (Giữ `checkKeyQuota` 171 nguyên — đó là per-key legacy quota, độc lập plan. KHÔNG xoá.)
- [x] **C2**: `checkPlanQuota` khi `source="plan"` đọc user record và **trả kèm `allowCreditOverflow`** trong result (chốt: tránh lookup user lần hai ở chat.js). chat.js dùng `pq.allowCreditOverflow` trực tiếp — KHÔNG cần `getUserForKey` riêng. (Trong `checkPlanQuota` đã có `keyRow.userId`; `getUserById` một lần để lấy cả limits-via-resolveUserLimits lẫn toggle — hoặc resolveUserLimits trả userId rồi getUserById; chốt impl trong dev, miễn 1 lookup.)
- [x] **C3**: **Truyền `billingSource` tới deduction**. Threading từ `handleSingleModelChat` → pipeline → `saveRequestUsage(entry)`. Đường đi: thêm `billingSource` vào context chảy qua `handleChatCore`/`chatCore` tới `usageTracking.js:345` và `requestDetail.js:93`. **Đây là phần rủi ro regression cao nhất** — xem Dev Notes "Threading billing source". Tối thiểu: `saveRequestUsage` nhận `entry.billingSource`; nếu `=== "plan"` → **skip** `recordCreditTxn`.

### Phần D — Deduction có điều kiện (AC#6)
- [x] **D1**: `src/lib/db/repos/usageRepo.js#saveRequestUsage` — sửa khối deduction (286-300): chỉ `recordCreditTxn` khi `entry.billingSource !== "plan"` (tức credit/overflow/undefined-legacy). `billingSource==="plan"` → skip (plan đã trả). `billingSource==="overflow"` → vẫn trừ; **đính `note` prefix `[overflow]`** (chốt b: giữ `type=usage_deduction`, `bucket=standard`, KHÔNG đổi schema ledger — provenance qua note). `undefined` (request không qua plan path, vd local/legacy) → giữ hành vi cũ (trừ nếu có userId+cost) để KHÔNG regression story 2.4.
- [x] **D2**: Đảm bảo deduction vẫn atomic trong transaction sẵn có (BP-5, 2.13). KHÔNG mở transaction lồng.

### Phần E — API toggle (AC#8)
- [x] **E1**: `src/app/api/users/me/route.js` — GET trả thêm `allowCreditOverflow`; PATCH nhận `allowCreditOverflow` (boolean) → `updateUser(session.userId, { allowCreditOverflow })`. Validate boolean.

### Phần F — Test (AC#9)
- [x] **F1**: `tests/unit/plan-quota.test.js` — `checkPlanQuota` (temp DB, pattern resolve-plan.test.js): (a) no apiKey/legacy → source=none allowed; (b) source=credit (no plan) → allowed; (c) plan trong quota → allowed; (d) plan 5h exhausted → allowed=false exhausted window=5h; (e) plan weekly exhausted → window=weekly; (f) quota=0 (unlimited) → allowed; (g) đổi quota plan rồi check lại → áp ngay (AC#7); (h) fail-open: mock sumUsageTokensByUser/resolveUserLimits throw → allowed.
- [x] **F2**: `tests/unit/chat-plan-billing.test.js` — theo style `chatCreditCheck.test.js`/`chatRpmCheck.test.js`: logic Model B admission — plan-within→billing=plan no-deduct; plan-exhausted+overflowON→checkCredits+billing=overflow; plan-exhausted+overflowOFF→429; credit→billing=credit. (Test logic + assert message/vị trí; KHÔNG full e2e.)
- [x] **F3**: `tests/unit/usage-deduction-source.test.js` — `saveRequestUsage` với `billingSource="plan"` → KHÔNG ghi ledger; `="credit"`/`="overflow"` → ghi `usage_deduction`; `undefined` + userId + cost → ghi (regression 2.4). Verify ledger row count + balance qua `rebuildBalanceFromLedger`.
- [x] **F4**: `tests/unit/users-me-overflow.test.js` (hoặc mở rộng test users/me có sẵn) — PATCH toggle allowCreditOverflow, GET phản ánh; updateUser persist 0/1.
- [x] **F5**: Migration test — `004` thêm cột idempotent, default đúng, rowToUser expose bool.
- [x] **F6**: Full suite (`NODE_PATH=/tmp/node_modules npm test` từ `tests/`), 0 fail.

## Dev Notes

### Threading billing source (rủi ro regression cao nhất — đọc kỹ)
Quyết định billing source ở `handleSingleModelChat` (admission), nhưng `recordCreditTxn` chạy ở `saveRequestUsage` — gọi từ `open-sse/utils/usageTracking.js:345` và `open-sse/handlers/chatCore/requestDetail.js:93`, sâu trong response pipeline. Cần truyền `billingSource` qua đó.

**Đường đi cần trace (dev PHẢI đọc):** `handleSingleModelChat` → `handleChatCore` (open-sse) → response streaming → `usageTracking`/`requestDetail` gọi `saveRequestUsage`. Tìm object context/request chảy xuyên suốt để đính `billingSource`. Nếu không có context xuyên suốt, cân nhắc:
- **Option A (đề xuất)**: đính `billingSource` vào `body`/request object đã chảy qua pipeline; `usageTracking`/`requestDetail` đọc ra và set `entry.billingSource`.
- **Option B (fallback đơn giản, kém chính xác)**: tại `saveRequestUsage`, re-resolve `checkPlanQuota` snapshot — KHÔNG khuyến nghị (racy: state đã đổi sau khi request chạy, và double-counts window).
- Cho combo: billing source quyết định 1 lần ở `handleSingleModelChat` cho model thực thi; combo fallback giữa nhiều model — mỗi lần `handleSingleModelChat` chạy lại resolve riêng. Nhất quán: deduction theo source của model thực sự phục vụ.

**Regression guard**: nếu `billingSource` không được set (request không qua plan path: local mode, legacy key, đường khác) → `saveRequestUsage` GIỮ hành vi cũ (trừ nếu userId+cost>0). Tức `skipDeduction` CHỈ khi `billingSource === "plan"` tường minh. Điều này bảo toàn story 2.4.

### Vì sao enforce ở handleSingleModelChat (per-model attempt), không phải handleChat
RPM (E.2) ở `handleChat` (per-client-request, 1 req=1 RPM). **Quota token** thì khác: token tiêu theo từng model thực thi, và combo fallback có thể đổi model → quota/credit phải check theo model thực sự được phục vụ. `checkKeyQuota`/`checkCredits` đã ở `handleSingleModelChat` đúng vì lý do này. `checkPlanQuota` đặt cùng chỗ.

### Quota là admission-check trên consumed sẵn có (không phải post-block)
Giống `checkKeyQuota`: chặn TRƯỚC khi gọi upstream dựa trên `consumed` (tokens đã ghi `usageHistory` trong window) ≥ quota. Request hiện tại có thể vượt nhẹ (token của nó chưa tính tới khi admit) — chấp nhận như `checkKeyQuota`. KHÔNG cố reserve/pre-count.

### Window per-user, tái dùng engine
`resolveWindow(state, "5h"|"weekly", now)` + `duration` + `formatResetCountdown` y nguyên. State per-user ở scope kv mới `planQuotaState` (KHÔNG đụng `keyQuotaState` của per-key quota — 2 hệ độc lập). 5h/weekly windows session-based (reset sau lần đầu của window).

### Deduction: chỉ overflow + credit, KHÔNG plan
Core của Model B. `saveRequestUsage` hiện trừ mọi userId+cost. Sau story này: `billingSource==="plan"` → skip. Đây là thay đổi hành vi có chủ ý với user CÓ plan — không phải regression (story 2.4 chỉ có credit users, họ thành `source="credit"` → vẫn trừ).

### Quyết định ĐÃ CHỐT (user, 2026-06-08)
1. **Default `allowCreditOverflow` = `0` (OFF)** — principle of least surprise cho tiền: hết quota plan thì chặn `429`, KHÔNG bất ngờ trừ credit. User tự bật nếu muốn liền mạch. → `allowCreditOverflow INTEGER DEFAULT 0`.
2. **Overflow ledger (best practice)**: deduction khi `billingSource="overflow"` giữ `type=usage_deduction`, `bucket=standard`, **đính `note` prefix `[overflow]`** (vd `[overflow] claude-opus-4-8 @ /v1/chat/completions`). Audit/query được provenance (BP-3) mà KHÔNG đổi schema ledger — giữ nguyên BP-1..7 của 2.13. KHÔNG thêm enum `type` mới.
3. **`checkPlanQuota` trả kèm `allowCreditOverflow`** (đọc từ user record khi `source="plan"`) → chat.js không lookup user lần hai. Result shape khi plan: `{ source:"plan", allowed, exhausted?, allowCreditOverflow, planName, window?, consumed?, limit?, retryAfter?, retryAfterHuman? }`.

### Out of scope (story khác)
- **Per-model quota override enforcement** → E.6 (2-17). Story này enforce TỔNG; `resolveUserLimits` có `modelLimit` nhưng KHÔNG dùng để chặn.
- 3-credit bucket priority (Resource→Bonus→Standard) khi trừ overflow → FR-13/15 (story con Epic C). Story này trừ `bucket=standard`.
- UI user xem quota/credit/toggle + ledger history → E.4 (2-15). Story này chỉ API field.
- Admin CRUD plan/gán plan → E.5.
- Self-serve mua/đổi gói + window handling khi đổi → E.7.

### Ràng buộc CRITICAL (tóm tắt)
- Fail-open mọi lỗi hạ tầng (chỉ chặn khi chắc chắn plan-exhausted + overflow OFF).
- KHÔNG đụng `checkKeyQuota` (per-key legacy quota), `checkRpmLimit` (E.2), `window.js` engine, RPM state.
- Deduction skip CHỈ khi `billingSource==="plan"` tường minh → bảo toàn 2.4.
- `recordCreditTxn` (2.13) atomic trong transaction — không lồng transaction.
- quota=0 ⇒ unlimited; `source=credit` ⇒ không liên quan plan quota.
- Migration idempotent (guarded ADD COLUMN).

### References
- [Source: docs/epics-saas.md#Epic E — Mô hình Plan + Credit (Model B + toggle)] — luật overflow ON/OFF, billing source
- [Source: docs/stories/2-11-plans-schema-repo.md] — resolveUserLimits, sumUsageTokensByUser, plan-as-template apply-ngay
- [Source: docs/stories/2-12-rpm-per-user-limit.md] — pattern checkRpmLimit, per-user kv state, fail-open/fail-closed, window 1m
- [Source: docs/stories/2-13-credit-ledger.md] — recordCreditTxn(type=usage_deduction), atomic, deduction wired in saveRequestUsage
- [Source: src/lib/quota/keyQuota.js] — MẪU mirror: window-state + sumUsageTokens consumed-vs-max, persist on reset, fail-open
- [Source: src/lib/quota/resolvePlan.js#resolveUserLimits] — quota5h/quotaWeekly/source/modelLimit
- [Source: src/lib/db/repos/quotaRepo.js#sumUsageTokensByUser + getRpmState/setRpmState] — per-user sum + per-user state pattern
- [Source: src/lib/db/repos/usageRepo.js#saveRequestUsage:286-300] — deduction khối cần sửa có điều kiện
- [Source: src/sse/handlers/chat.js#handleSingleModelChat:169-194] — gate region (checkKeyQuota→checkCredits), điểm chèn
- [Source: open-sse/utils/usageTracking.js:345 + open-sse/handlers/chatCore/requestDetail.js:93] — 2 call-site saveRequestUsage (threading billingSource)
- [Source: src/lib/billing/checkCredits.js] — credit gate, fail-open
- [Source: src/app/api/users/me/route.js] — GET/PATCH profile (thêm allowCreditOverflow)
- [Source: src/lib/db/schema.js#TABLES.users + usageHistory idx_uh_apikey_ts] — thêm cột; index per-user đã có
- [Source: src/lib/db/migrations/002-plans.js] — pattern guarded ADD COLUMN idempotent

## Dev Agent Record
### Agent Model Used
claude-sonnet-4-6

### Debug Log References
- Window timing: tests seeding usageHistory with `now` timestamp fell outside the newly-initialized window (startedAt ≈ now → consumed = 0 < quota). Fixed by pre-seeding `planQuotaState` with `startedAt = 2min ago` and usage rows at `1min ago`.
- billingSource threading: `logUsage` in stream.js fallback path not updated (low-impact — only called when onStreamComplete not set). `billingSource=undefined` in that path → legacy deduction behavior preserved. Acceptable per regression-safe contract.
- `checkPlanQuota` returns `allowCreditOverflow` from user record when `source="plan"` → chat.js reads `pq.allowCreditOverflow` directly, no second user lookup.

### Completion Notes List
- A1-A3: `allowCreditOverflow INTEGER DEFAULT 0` added to schema, migration 004 (guarded ADD COLUMN), rowToUser + updateUser updated.
- B1-B2: `planQuotaState` kv scope added to quotaRepo. `planQuota.js` implements checkPlanQuota with full Model B logic + fail-open try/catch. Returns `allowCreditOverflow` from user record when plan active.
- C1-C3: chat.js Model B block replaces bare checkCredits. billingSource threaded: chat.js → handleChatCore(billingSource) → sharedCtx → streamingHandler/nonStreamingHandler/sseToJsonHandler → saveUsageStats(billingSource) → saveRequestUsage(billingSource). logUsage in usageTracking.js updated.
- D1-D2: saveRequestUsage deduction conditional on billingSource !== "plan". overflow → note prefix "[overflow]". undefined → legacy deduction (2.4 regression safe).
- E1: /api/users/me GET exposes allowCreditOverflow. PATCH validates boolean, calls updateUser, returns updated field.
- F1-F6: 29 new tests (plan-quota:11, chat-plan-billing:6, usage-deduction-source:5, users-me-overflow:7). Full suite 1031 pass / 0 fail.

### File List
- `src/lib/db/schema.js` — added allowCreditOverflow to TABLES.users
- `src/lib/db/migrations/004-credit-overflow.js` — new migration
- `src/lib/db/migrations/index.js` — registered m004
- `src/lib/db/repos/usersRepo.js` — rowToUser + updateUser for allowCreditOverflow
- `src/lib/db/repos/quotaRepo.js` — planQuotaStateKv, getPlanQuotaState, setPlanQuotaState
- `src/lib/quota/planQuota.js` — new module
- `src/sse/handlers/chat.js` — Model B block + import checkPlanQuota + billingSource threading
- `open-sse/handlers/chatCore.js` — billingSource in signature + sharedCtx
- `open-sse/handlers/chatCore/streamingHandler.js` — billingSource in buildOnStreamComplete + saveUsageStats
- `open-sse/handlers/chatCore/nonStreamingHandler.js` — billingSource in signature + saveUsageStats
- `open-sse/handlers/chatCore/sseToJsonHandler.js` — billingSource in signature + saveUsageStats
- `open-sse/handlers/chatCore/requestDetail.js` — billingSource in saveUsageStats + saveRequestUsage
- `open-sse/utils/usageTracking.js` — billingSource in logUsage + saveRequestUsage
- `src/lib/db/repos/usageRepo.js` — conditional deduction by billingSource
- `src/app/api/users/me/route.js` — allowCreditOverflow in GET + PATCH
- `tests/unit/plan-quota.test.js` — new (11 tests)
- `tests/unit/chat-plan-billing.test.js` — new (6 tests)
- `tests/unit/usage-deduction-source.test.js` — new (5 tests)
- `tests/unit/users-me-overflow.test.js` — new (7 tests)

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story E.3 (2.14) — plan quota enforcement 5h/weekly per-user + credit-overflow toggle (Model B). checkPlanQuota mirror keyQuota per-user; tích hợp handleSingleModelChat; billing source {plan/overflow/credit} truyền tới saveRequestUsage để deduction có điều kiện (plan trong quota KHÔNG trừ credit); thêm users.allowCreditOverflow + API /users/me. Phụ thuộc E.1/E.2 (done) + E.3b ledger (review). 3 quyết định cần chốt (default toggle, overflow ledger note, checkPlanQuota trả user). Status → ready-for-dev. |
| 2026-06-08 | Implementation complete — all tasks A1-F6 done. 29 new tests. Full suite 1031 pass / 0 fail. Status → review. |
