# B5 follow-ups (orchestrator tự xử sau khi đội fix xong)

## [F1] stt/tts: core chưa nhận callback (fix C dở dang)
- stt.js/tts.js truyền onCredentialsRefreshed/onRequestSuccess vào handleSttCore/handleTtsCore
- NHƯNG open-sse/handlers/sttCore.js:170 + ttsCore.js chỉ nhận {provider,model,formData/input,credentials} — KHÔNG gọi callback
- embeddingsCore.js:18-19,80,112 là pattern đúng (có nhận + gọi)
- FIX: thêm onCredentialsRefreshed/onRequestSuccess vào sttCore + ttsCore, gọi đúng chỗ (sau refresh token, sau success) giống embeddingsCore. Không agent nào sở hữu 2 core này.
- Verify: chạy lại sttCore-contract + ttsCore-contract sau khi sửa.

## [F2] MÂU THUẪN baseline — phải điều tra ở B7
- Baseline orchestrator chạy trên develop 5dbcc91b TRƯỚC fix = 1983 pass, 0 fail (file /tmp .../baseline.txt)
- Agent B báo "26 test fail pre-existing" (announcementsPublic, authLogin, key-quota-api, v1beta-*, logger)
- => KHÔNG khớp. 26 fail này hoặc do fix A/C/D vừa gây, hoặc do test chạy song song lúc nhiều agent đang sửa file.
- HÀNH ĐỘNG: B7 chạy lại FULL test khi cả 4 agent đã xong & im. So với baseline 1983/0. Mọi fail = regression cần fix.

## [F3] REGRESSION xác định: v1beta auth guard phá test (D báo)
- Agent A/C thêm auth guard vào src/app/api/v1beta/models/route.js
- Test unit/v1beta-gemini-chat.test.js + unit/v1beta-models.test.js (27 test) gọi GET()/POST() KHÔNG truyền request arg
- => extractApiKey(undefined) ném lỗi => 27 fail. ĐÂY là nguồn "26 fail" agent B thấy.
- FIX (B7): hoặc (a) sửa test truyền request giả có headers, hoặc (b) guard chịu được request=undefined an toàn. Phải khớp ý đồ auth của agent A — đọc A-auth.md trước.
