import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Enum hợp lệ cho products (AC5)
export const PRODUCT_KINDS = ["plan", "credential", "account", "service", "api_package"];
export const DELIVERY_MODES = ["instant", "admin_fulfill", "user_self_connect"];

/**
 * Map DB row → product object.
 */
function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description ?? null,
    priceCredits: row.priceCredits,
    deliveryMode: row.deliveryMode,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    stock: row.stock ?? null,          // null = unlimited
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Liệt kê tất cả products đang active.
 * Dùng cho /products handler và GET /api/store/products (AC2).
 */
export async function listActiveProducts() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM products WHERE isActive = 1 ORDER BY name ASC`
  );
  return rows.map(rowToProduct);
}

/**
 * Lấy product theo ID (trả null nếu không tìm thấy).
 */
export async function getProductById(id) {
  const db = await getAdapter();
  return rowToProduct(db.get(`SELECT * FROM products WHERE id = ?`, [id]));
}

/**
 * Tạo product mới — dùng cho admin (story 2.28).
 * Validation enum + range (AC5, A3).
 */
export async function createProduct(data) {
  if (!data || typeof data !== "object") {
    throw new Error("createProduct: data là object bắt buộc");
  }
  if (!data.kind || !PRODUCT_KINDS.includes(data.kind)) {
    throw new Error(`createProduct: kind phải là một trong [${PRODUCT_KINDS.join(", ")}]`);
  }
  if (!data.deliveryMode || !DELIVERY_MODES.includes(data.deliveryMode)) {
    throw new Error(`createProduct: deliveryMode phải là một trong [${DELIVERY_MODES.join(", ")}]`);
  }
  if (!data.name || typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("createProduct: name là trường bắt buộc");
  }
  if (typeof data.priceCredits !== "number" || isNaN(data.priceCredits) || data.priceCredits < 0) {
    throw new Error("createProduct: priceCredits phải là số không âm");
  }
  if (
    data.stock !== undefined &&
    data.stock !== null &&
    (typeof data.stock !== "number" || !Number.isInteger(data.stock) || data.stock < 0)
  ) {
    throw new Error("createProduct: stock phải là null (không giới hạn) hoặc số nguyên >= 0");
  }

  const db = await getAdapter();
  const id = data.id || uuidv4();
  const now = new Date().toISOString();
  const isActive = data.isActive !== false ? 1 : 0;

  db.run(
    `INSERT INTO products(id, kind, name, description, priceCredits, deliveryMode, targetType, targetId, stock, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.kind,
      data.name.trim(),
      data.description ?? null,
      data.priceCredits,
      data.deliveryMode,
      data.targetType ?? null,
      data.targetId ?? null,
      data.stock ?? null,
      isActive,
      now,
      now,
    ]
  );

  return rowToProduct({
    id,
    kind: data.kind,
    name: data.name.trim(),
    description: data.description ?? null,
    priceCredits: data.priceCredits,
    deliveryMode: data.deliveryMode,
    targetType: data.targetType ?? null,
    targetId: data.targetId ?? null,
    stock: data.stock ?? null,
    isActive,
    createdAt: now,
    updatedAt: now,
  });
}
