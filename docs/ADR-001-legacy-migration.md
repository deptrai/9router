# ADR 001: Chiến lược di trú ứng dụng Legacy sang Turborepo Monorepo

## Bối cảnh
Trước Story 1.1, dự án 9Router là ứng dụng monolithic Next.js App Router đơn lẻ đặt tại thư mục gốc (`src/`), kết hợp các API route AI Proxy (`/v1/*`) và prototype Telegram Mini App e-commerce chạy trên SQLite đồng bộ.

Theo kiến trúc mục tiêu (ARCHITECTURE-SPINE.md) và PRD 9Router E-Commerce, nền tảng chuyển đổi sang:
- Turborepo Monorepo
- Next.js 16 App Router cho Telegram Mini App (`apps/mini-app`)
- Next.js 16 App Router cho Admin Portal (`apps/admin`)
- NestJS 11+ cho Backend API (`apps/api`)
- PostgreSQL 16 + Drizzle ORM (`packages/database`)
- Thư viện kiểu và hợp đồng dùng chung (`packages/shared-types`)

## Quyết định
1. **Di chuyển toàn bộ mã nguồn cũ vào `apps/legacy`:**
   - Toàn bộ `src/`, `open-sse/`, `scripts/` và các cấu hình liên quan của prototype cũ được bảo tồn nguyên vẹn trong `apps/legacy`.
   - Đổi tên package legacy thành `@repo/legacy` trong `apps/legacy/package.json`.
   - Giữ nguyên lịch sử code và business logic tham chiếu cho các story tiếp theo (1.2 -> 5.x).

2. **Khởi tạo không gian làm việc sạch cho monorepo:**
   - Sử dụng `pnpm` workspaces với `pnpm-workspace.yaml`.
   - Điều phối tác vụ bằng Turborepo (`turbo.json`).
   - Xóa các lockfile không nhất quán ở root (`package-lock.json`, `bun.lock`), chuẩn hóa duy nhất `pnpm-lock.yaml`.

3. **Nguyên tắc di trú tăng dần:**
   - Story 1.1 chỉ tập trung vào khung kiến trúc (scaffold), build pipeline, shared packages và dev infrastructure.
   - Các story sau (1.2, 1.3, 1.4, 2.x, ...) sẽ trích xuất và viết lại các domain services vào `apps/api` và UI vào `apps/mini-app`/`apps/admin` theo mô hình bất đồng bộ chuẩn Drizzle/PostgreSQL.
