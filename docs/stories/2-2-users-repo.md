---
title: "Story 2.2 — usersRepo đầy đủ + unit test"
story_id: "2.2"
story_key: "2-2-users-repo"
epic: "A — User Accounts & Authentication"
status: in-progress
baseline_commit: 50638d7d3b1e0d504b4c348e3692a94a2cc96051
created: 2026-06-06
---

# Story 2.2 — usersRepo đầy đủ + unit test

## Status: in-progress

## Story
**As a** hệ thống 9Router SaaS,
**I want** có `usersRepo` với đầy đủ CRUD operations cho bảng `users`,
**so that** các story sau (register, login, credit billing, admin topup) có data layer sẵn sàng.

## Acceptance Criteria

**AC1** — `createUser(email, passwordHash, displayName)` tạo user mới, return object đầy đủ (không chứa passwordHash).
**AC2** — `getUserByEmail(email)` lookup trả object bao gồm passwordHash (cho login verify).
**AC3** — `getUserById(id)` lookup trả object không chứa passwordHash.
**AC4** — `updateUser(id, data)` update displayName / passwordHash / isEmailVerified.
**AC5** — `addCredits(id, amount)` atomic increment `creditsBalance`. Nhận `amount` âm (trừ) hoặc dương (cộng).
**AC6** — `listUsers()` admin list all users, KHÔNG trả passwordHash.
**AC7** — `deactivateUser(id)` soft delete: set `isActive = 0`.
**AC8** — Duplicate email → throw Error.
**AC9** — Export qua `src/lib/db/index.js`.

## Tasks

- [ ] Task 1: Tạo `src/lib/db/repos/usersRepo.js` với tất cả functions
- [ ] Task 2: Export usersRepo functions qua `src/lib/db/index.js`
- [ ] Task 3: Unit test `tests/unit/usersRepo.test.js`

## Dev Notes
- Pattern: copy từ `apiKeysRepo.js` — dùng `getAdapter()`, `db.run/get/all`, `uuidv4()`.
- `rowToUser(row)` — map row, LOẠI passwordHash. `rowToUserWithHash(row)` — map row kèm hash (chỉ dùng cho `getUserByEmail`).
- `addCredits`: dùng `creditsBalance = creditsBalance + ?` (SQL arithmetic, atomic). KHÔNG đọc rồi ghi.
- Test env: `process.env.DATA_DIR = tempDir`, `delete global._dbAdapter`, `vi.resetModules()`.

## Dev Agent Record
### File List
_(filled on completion)_
### Change Log
- 2026-06-06: Story created + dev started
