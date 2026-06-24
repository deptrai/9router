# Fix-guide chung — đội sửa backend 9router

Bạn là kỹ sư sửa lỗi backend 9router, làm trong WORKTREE: `/Users/luisphan/Documents/9router/.claude/worktrees/fix-backend-review`. Báo cáo review nguồn ở `_review/R1..R6-*.md` và `_review/_SUMMARY.md` trong worktree này.

## Nguyên tắc tối thượng (yêu cầu user: "không tính năng nào bị lỗi sau khi sửa")
1. **Chỉ sửa file thuộc vùng được giao** (danh sách trong prompt). Tuyệt đối KHÔNG sửa file ngoài vùng — 4 agent chạy song song, đụng file = hỏng.
2. **Fix kỹ thuật-an toàn thì làm ngay:** thêm auth guard còn thiếu, thêm `export const dynamic='force-dynamic'`, thêm `await` thiếu, sửa import thiếu (NextResponse), thêm validate/guard SSRF, sửa nuốt lỗi, fix race bằng promise-singleton, escape shell an toàn, đổi `console.log`→`console.error`, thêm timeout.
3. **KHÔNG tự đổi HÀNH VI NGHIỆP VỤ** — ghi vào `_fix/DECISIONS.md` thay vì sửa. Gồm: chính sách CORS (đang `*`), affiliate `vnd_topup` có trả hoa hồng không, auto-refund khi huỷ đơn, đổi balance float→int, đổi quota từ soft→hard limit, OIDC role policy. Lý do: đổi mấy cái này có thể phá tính năng đang chạy hoặc trái thiết kế — cần user quyết.
4. **Bảo toàn hành vi hiện có.** Khi thêm auth guard, giữ đúng path hợp lệ vẫn qua được (vd. `requireLogin=false` là chế độ opt-out HỢP LỆ — đừng chặn cứng, chỉ chặn đúng lỗ hổng: default-role-admin khi KHÔNG có session). Đọc kỹ luồng trước khi sửa.
5. **Mỗi finding "cần xác minh" trong report:** xác minh bằng đọc code thật trước khi sửa. Nếu thực ra an toàn → ghi vào report là "không cần sửa, đã verify", đừng sửa thừa.

## Quy trình
1. Đọc các finding thuộc vùng mình trong `_review/R*.md`.
2. Với mỗi finding: Read file → hiểu luồng → sửa tối thiểu, đúng trọng tâm → giữ style xung quanh.
3. Sau khi sửa xong nhóm file, CHẠY TEST liên quan để chắc không phá:
   `cd /Users/luisphan/Documents/9router/.claude/worktrees/fix-backend-review/tests && npm test -- unit/<file>.test.js`
   (deps đã có sẵn; baseline hiện tại 1983 pass 0 fail — đừng làm đỏ test nào đang xanh).
4. Nếu fix của bạn cần test mới (vd. guard auth mới) và vùng bạn có thời gian, thêm test — nhưng ưu tiên không phá test cũ.

## Ghi kết quả
Ghi `_fix/<agent-id>.md`:
```markdown
# Fix vùng <agent-id>
## Đã sửa
### [ref tới R?-P?-?] <tiêu đề>
- File: path:line
- Sửa gì: <mô tả ngắn> + trích đoạn thay đổi chính
- Test đã chạy: <file test + pass/fail>
## Đã verify KHÔNG cần sửa
- <finding> — lý do
## Chuyển sang DECISIONS (đổi hành vi nghiệp vụ — cần user quyết)
- <finding> — vì sao không tự đổi
```
Nếu có mục nghiệp vụ, APPEND vào `_fix/DECISIONS.md` (tạo nếu chưa có), format: `- [R?-P?-?] <vấn đề> — <2 lựa chọn + khuyến nghị>`.

Cuối cùng trả về cho orchestrator: số finding đã fix / ver-no-fix / chuyển-decisions + 1 dòng rủi ro regression nếu có.
