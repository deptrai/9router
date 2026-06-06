# 9Router SaaS — Roadmap & Status

## Documents đã tạo
- `docs/SAAS_ARCHITECTURE.md` — phân tích tổng quan ban đầu
- `docs/ARCHITECTURE_SAAS_MULTITENANT.md` — quyết định kỹ thuật chi tiết (schema, auth, billing)
- `docs/PRD_SAAS_MVP.md` — **PRD final** (37 FRs, 8 epics, 100% TrollLLM parity)

## Quyết định đã chốt
- Credit-based billing (USD nội bộ, 1000đ = $1 cho VN)
- 3 loại credit: Standard / Bonus (×hệ số, hạn 14d) / Resource
- Payment: **Casso** webhook (QR bank transfer VN)
- Email verification: **Resend**
- Max 10 API key/user
- 6 subscription tiers (Lite→Elite) + PAYG
- Zero migration khi có thể (syncSchemaFromTables)
- Fail-open billing (không chết request vì bug)

## Phasing
| Đợt | Epics | Trạng thái |
|------|-------|-----------|
| MVP-1 | A (Auth) + B (Key) + C cơ bản (1 loại credit) + G cơ bản (Dashboard) | ⏳ Tiếp theo |
| MVP-2 | D (Payment Casso) + F (Gift code) + C đầy đủ (3 loại credit) | Planned |
| MVP-3 | E (Subscription/RPM) + H (Landing) | Planned |

## Bước tiếp theo
1. **Chạy `bmad-create-epics-and-stories`** dựa trên `docs/PRD_SAAS_MVP.md` — tạo stories cho MVP-1 trước.
2. Sau đó `bmad-dev-story` từng story (giống Sprint 1).
3. Push/deploy/test production mỗi story xong.

## Sprint 1 (hoàn thành)
- Story 1.1: tool_choice honoring ✅
- Story 1.2: Kiro token count ✅
- Story 1.3: Per-key quota ✅
- Story 1.4: Kiro max_tokens + usage ✅
