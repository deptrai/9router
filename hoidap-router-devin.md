# Câu hỏi cho dev router.chainlens.net

## Context

Tôi đang dùng **Devin CLI** (Codeium/Windsurf CLI) — phiên bản 2026.8.18, binary Rust, dùng `reqwest` + `rustls`.

**Vấn đề:** Devin CLI gửi request AI model qua **gRPC-web** (protobuf) đến `server.codeium.com` (Codeium API server). Tôi đã có tài khoản Devin Pro và API key `sk-0849532159e34419-glxqhl-420fab5d` dùng được với `router.chainlens.net/v1` cho OpenAI-compatible endpoints (chat/completions hoạt động tốt).

**Mục tiêu:** Cho Devin CLI gọi model qua `router.chainlens.net` thay vì qua `server.codeium.com`, để tận dụng unlimited quota + tự động routing giữa các tài khoản.

## Kiến trúc hiện tại

```
Devin CLI ──gRPC-web──→ server.codeium.com (bị quota giới hạn)
```

## Mong muốn

```
Devin CLI ──gRPC-web──→ router.chainlens.net ──(???)──→ upstream provider
```

## Các request Devin CLI gửi (đã capture)

### Auth/Management (gRPC-web)
- `POST /exa.seat_management_pb.SeatManagementService/GetUserStatus`
- `POST /exa.seat_management_pb.SeatManagementService/GetTeamSettings`
- (các service `.seat_management_pb.`, `.chat_pb.`, `.codex_pb.`...)

### Header mẫu
```
Content-Type: application/grpc-web+proto
Authorization: Bearer devin-session-token$<JWT>
```

## Test thực tế

| Endpoint | Method | Kết quả |
|----------|--------|---------|
| `router.chainlens.net/v1/chat/completions` | OpenAI REST | ✅ 200 |
| `router.chainlens.net/v1/models` | OpenAI REST | ✅ 200 (có `windsurf/*` models) |
| `router.chainlens.net/exa.seat_management_pb.SeatManagementService/GetUserStatus` | gRPC-web | ❌ 404 |
| `router.chainlens.net/devin/...` (prefix) | gRPC-web | ❌ 404 |
| `router.chainlens.net/codeium/...` (prefix) | gRPC-web | ❌ 404 |

## Câu hỏi

1. **Router có hỗ trợ gRPC/gRPC-web không?** Nếu có thì endpoint path / port là gì?

2. **Nếu không hỗ trợ gRPC:** Có cách nào để Devin CLI (chỉ nói được gRPC-web) dùng được router không? Ví dụ:
   - Router có thể thêm gRPC gateway?
   - Hay có hướng dẫn xây translation layer (gRPC-web → OpenAI REST)?

3. **Auth mapping:** Dùng API key `sk-...` của router để xác thực là đủ, hay Devin CLI cần gửi kèm Devin session token? Nếu router tự route giữa các Devin account dựa trên API key thì càng tốt.

4. **Model mapping:** Devin CLI chọn model bằng một cái tên nội bộ (vd `v98/gpt-5.5-high` trong response của model list). Làm sao để map đúng model Devin CLI muốn sang model ID của router?

## Gợi ý giải pháp (nếu router muốn hỗ trợ)

Nếu router có thể implement **gRPC-web proxy endpoint** tại domain `grpc.router.chainlens.net` hoặc path prefix `/grpc/` (tức là `router.chainlens.net/grpc/exa.chat_pb.ChatService/Generate`), thì Devin CLI có thể trỏ `WINDSURF_API_SERVER_URL` về đó.

Hoặc đơn giản nhất: router thêm 1 **gRPC gateway** reverse proxy cho `server.codeium.com` — Devin CLI sẽ gửi gRPC-web lên router, router forward thẳng lên Codeium server với token mapping phía backend.
