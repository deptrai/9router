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
    // Story 2.30: external source fields (null for local products)
    source: row.source ?? "local",
    supplierSourceId: row.supplierSourceId ?? null,
    supplierProductId: row.supplierProductId ?? null,
    syncVersion: row.syncVersion ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
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


/**
 * Liệt kê TẤT CẢ products (active + inactive) — dùng cho admin (Story 2.27 T5).
 */
export async function listAllProducts() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM products ORDER BY createdAt DESC`);
  return rows.map(rowToProduct);
}

/**
 * Kiểm tra product đã có order nào chưa — guard cho deleteProduct (T5).
 * Trả true nếu tồn tại ít nhất 1 order tham chiếu productId.
 */
export async function productHasOrders(productId) {
  if (!productId) return false;
  const db = await getAdapter();
  const row = db.get(
    `SELECT COUNT(*) AS c FROM orderItems WHERE productId = ?`,
    [productId]
  );
  return (row?.c ?? 0) > 0;
}

/**
 * Cập nhật product — admin (T5). Chỉ cập nhật các field được truyền vào (partial).
 * Validation theo cùng quy tắc createProduct cho field có mặt.
 */
export async function updateProduct(id, data) {
  if (!id) throw new Error("updateProduct: id là bắt buộc");
  if (!data || typeof data !== "object") {
    throw new Error("updateProduct: data là object bắt buộc");
  }

  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) throw new Error("updateProduct: không tìm thấy product");

  const fields = [];
  const values = [];

  if (data.kind !== undefined) {
    if (!PRODUCT_KINDS.includes(data.kind)) {
      throw new Error(`updateProduct: kind phải là một trong [${PRODUCT_KINDS.join(", ")}]`);
    }
    fields.push("kind = ?");
    values.push(data.kind);
  }
  if (data.deliveryMode !== undefined) {
    if (!DELIVERY_MODES.includes(data.deliveryMode)) {
      throw new Error(`updateProduct: deliveryMode phải là một trong [${DELIVERY_MODES.join(", ")}]`);
    }
    fields.push("deliveryMode = ?");
    values.push(data.deliveryMode);
  }
  if (data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim()) {
      throw new Error("updateProduct: name phải là chuỗi không rỗng");
    }
    fields.push("name = ?");
    values.push(data.name.trim());
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description ?? null);
  }
  if (data.priceCredits !== undefined) {
    if (typeof data.priceCredits !== "number" || isNaN(data.priceCredits) || data.priceCredits < 0) {
      throw new Error("updateProduct: priceCredits phải là số không âm");
    }
    fields.push("priceCredits = ?");
    values.push(data.priceCredits);
  }
  if (data.targetType !== undefined) {
    fields.push("targetType = ?");
    values.push(data.targetType ?? null);
  }
  if (data.targetId !== undefined) {
    fields.push("targetId = ?");
    values.push(data.targetId ?? null);
  }
  if (data.stock !== undefined) {
    if (
      data.stock !== null &&
      (typeof data.stock !== "number" || !Number.isInteger(data.stock) || data.stock < 0)
    ) {
      throw new Error("updateProduct: stock phải là null (không giới hạn) hoặc số nguyên >= 0");
    }
    fields.push("stock = ?");
    values.push(data.stock ?? null);
  }
  if (data.isActive !== undefined) {
    fields.push("isActive = ?");
    values.push(data.isActive !== false ? 1 : 0);
  }

  if (!fields.length) {
    return rowToProduct(existing);
  }

  const now = new Date().toISOString();
  fields.push("updatedAt = ?");
  values.push(now);
  values.push(id);

  db.run(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, values);
  return rowToProduct(db.get(`SELECT * FROM products WHERE id = ?`, [id]));
}

/**
 * Xoá product — admin (T5). Chặn xoá nếu product đã có order (toàn vẹn lịch sử).
 * Khuyến nghị admin set isActive=false thay vì xoá khi đã có order.
 */
export async function deleteProduct(id) {
  if (!id) throw new Error("deleteProduct: id là bắt buộc");
  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) throw new Error("deleteProduct: không tìm thấy product");

  if (await productHasOrders(id)) {
    throw new Error(
      "deleteProduct: product đã có order, không thể xoá. Hãy set isActive=false để ẩn."
    );
  }

  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  return { deleted: true, id };
}
