import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Enum hợp lệ cho entitlements (Story 2.29a)
// pending_connection → user đã mua nhưng chưa kết nối tài khoản provider của họ
// active            → đã link tới một providerConnection, sẵn sàng route
// expired           → quá expiresAt
// revoked           → admin/hệ thống thu hồi
// Single source of truth cho status (E8) — import thay vì hardcode string rải rác.
export const ENTITLEMENT_STATUS = Object.freeze({
  PENDING: "pending_connection", // user đã mua nhưng chưa kết nối account provider
  ACTIVE: "active",              // đã link tới providerConnection, sẵn sàng route
  EXPIRED: "expired",            // quá expiresAt
  REVOKED: "revoked",            // admin/hệ thống thu hồi
});

// Mảng dẫn xuất (giữ thứ tự pending→active→expired→revoked cho validate + test).
export const ENTITLEMENT_STATUSES = Object.values(ENTITLEMENT_STATUS);

// prefer_owned → ưu tiên connection do user sở hữu, fallback pool admin
// owned_only   → chỉ dùng connection của chính user
export const ROUTE_POLICY = Object.freeze({
  PREFER_OWNED: "prefer_owned",
  OWNED_ONLY: "owned_only",
});
export const ROUTE_POLICIES = Object.values(ROUTE_POLICY);

// Các chuyển trạng thái hợp lệ (giống ORDER_STATUSES pattern trong ordersRepo)
const VALID_TRANSITIONS = {
  [ENTITLEMENT_STATUS.PENDING]: [ENTITLEMENT_STATUS.ACTIVE, ENTITLEMENT_STATUS.REVOKED],
  [ENTITLEMENT_STATUS.ACTIVE]: [ENTITLEMENT_STATUS.EXPIRED, ENTITLEMENT_STATUS.REVOKED],
  [ENTITLEMENT_STATUS.EXPIRED]: [ENTITLEMENT_STATUS.ACTIVE, ENTITLEMENT_STATUS.REVOKED], // re-link/gia hạn
  [ENTITLEMENT_STATUS.REVOKED]: [],
};

export function canTransitionEntitlement(from, to) {
  if (from === to) return true;
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

/**
 * Map DB row → entitlement object.
 */
function rowToEntitlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    productId: row.productId,
    provider: row.provider ?? null,
    status: row.status,
    providerConnectionId: row.providerConnectionId ?? null,
    routePolicy: row.routePolicy ?? "prefer_owned",
    expiresAt: row.expiresAt ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Tạo entitlement mới (mặc định status=pending_connection).
 * Dùng bởi storeCheckout khi fulfill product deliveryMode=user_self_connect (AC1).
 */
export async function createEntitlement(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const ent = {
    id: data.id || uuidv4(),
    userId: data.userId,
    productId: data.productId,
    provider: data.provider ?? null,
    status: data.status || "pending_connection",
    providerConnectionId: data.providerConnectionId ?? null,
    routePolicy: data.routePolicy || "prefer_owned",
    expiresAt: data.expiresAt ?? null,
    note: data.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (!ent.userId) throw new Error("createEntitlement: userId required");
  if (!ent.productId) throw new Error("createEntitlement: productId required");
  if (!ENTITLEMENT_STATUSES.includes(ent.status)) {
    throw new Error(`createEntitlement: invalid status ${ent.status}`);
  }
  if (!ROUTE_POLICIES.includes(ent.routePolicy)) {
    throw new Error(`createEntitlement: invalid routePolicy ${ent.routePolicy}`);
  }
  db.run(
    `INSERT INTO entitlements(id, userId, productId, provider, status, providerConnectionId, routePolicy, expiresAt, note, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ent.id, ent.userId, ent.productId, ent.provider, ent.status,
      ent.providerConnectionId, ent.routePolicy, ent.expiresAt, ent.note,
      ent.createdAt, ent.updatedAt,
    ]
  );
  return ent;
}

/** Synchronous variant — phải gọi BÊN TRONG một transaction (checkout). */
export function createEntitlementSync(db, data) {
  const now = data.now || new Date().toISOString();
  const ent = {
    id: data.id || uuidv4(),
    userId: data.userId,
    productId: data.productId,
    provider: data.provider ?? null,
    status: data.status || ENTITLEMENT_STATUS.PENDING,
    providerConnectionId: data.providerConnectionId ?? null,
    routePolicy: data.routePolicy || ROUTE_POLICY.PREFER_OWNED,
    expiresAt: data.expiresAt ?? null,
    note: data.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
  // Validate trong txn — fail rõ ràng thay vì để raw SQLite constraint error.
  if (!ent.userId) throw new Error("createEntitlementSync: userId required");
  if (!ent.productId) throw new Error("createEntitlementSync: productId required");
  if (!ENTITLEMENT_STATUSES.includes(ent.status)) {
    throw new Error(`createEntitlementSync: invalid status ${ent.status}`);
  }
  if (!ROUTE_POLICIES.includes(ent.routePolicy)) {
    throw new Error(`createEntitlementSync: invalid routePolicy ${ent.routePolicy}`);
  }
  db.run(
    `INSERT INTO entitlements(id, userId, productId, provider, status, providerConnectionId, routePolicy, expiresAt, note, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ent.id, ent.userId, ent.productId, ent.provider, ent.status,
      ent.providerConnectionId, ent.routePolicy, ent.expiresAt, ent.note,
      ent.createdAt, ent.updatedAt,
    ]
  );
  return ent;
}

export async function getEntitlementById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM entitlements WHERE id = ?`, [id]);
  return rowToEntitlement(row);
}

/**
 * Liệt kê entitlements của một user, mới nhất trước.
 * filter.status (string | string[]) lọc theo trạng thái.
 */
export async function listEntitlementsByUser(userId, filter = {}) {
  const db = await getAdapter();
  const where = ["userId = ?"];
  const params = [userId];
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
  }
  const rows = db.all(
    `SELECT * FROM entitlements WHERE ${where.join(" AND ")} ORDER BY createdAt DESC`,
    params
  );
  return rows.map(rowToEntitlement);
}

/**
 * Tìm entitlement đang chờ kết nối của user cho một provider cụ thể.
 * Dùng khi user kết nối tài khoản để link connection vào entitlement (AC3).
 */
export async function findPendingEntitlement(userId, provider) {
  const db = await getAdapter();
  // provider=null (QĐ3 fail-safe) cần `IS NULL` — SQL `= NULL` không bao giờ match.
  const providerClause = provider == null ? "provider IS NULL" : "provider = ?";
  const params = provider == null ? [userId] : [userId, provider];
  const row = db.get(
    `SELECT * FROM entitlements
     WHERE userId = ? AND ${providerClause} AND status = ?
     ORDER BY createdAt ASC LIMIT 1`,
    [...params, ENTITLEMENT_STATUS.PENDING]
  );
  return rowToEntitlement(row);
}

/**
 * Liệt kê entitlements theo product (AC4) — mới nhất trước.
 */
export async function getEntitlementsByProduct(productId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM entitlements WHERE productId = ? ORDER BY createdAt DESC`,
    [productId]
  );
  return rows.map(rowToEntitlement);
}

/**
 * Chuyển trạng thái entitlement an toàn (validate transition).
 * patch có thể kèm providerConnectionId, expiresAt, note.
 */
export async function transitionEntitlement(id, toStatus, patch = {}) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM entitlements WHERE id = ?`, [id]);
    if (!row) throw new Error(`transitionEntitlement: entitlement ${id} not found`);
    if (!ENTITLEMENT_STATUSES.includes(toStatus)) {
      throw new Error(`transitionEntitlement: invalid status ${toStatus}`);
    }
    if (!canTransitionEntitlement(row.status, toStatus)) {
      throw new Error(
        `transitionEntitlement: illegal transition ${row.status} → ${toStatus}`
      );
    }
    const now = new Date().toISOString();
    const next = {
      providerConnectionId:
        patch.providerConnectionId !== undefined
          ? patch.providerConnectionId
          : row.providerConnectionId,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : row.expiresAt,
      note: patch.note !== undefined ? patch.note : row.note,
    };
    db.run(
      `UPDATE entitlements
       SET status = ?, providerConnectionId = ?, expiresAt = ?, note = ?, updatedAt = ?
       WHERE id = ?`,
      [toStatus, next.providerConnectionId, next.expiresAt, next.note, now, id]
    );
    result = rowToEntitlement(
      db.get(`SELECT * FROM entitlements WHERE id = ?`, [id])
    );
  });
  return result;
}
