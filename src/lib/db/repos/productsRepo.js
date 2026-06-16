import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Enum hợp lệ cho products (AC5)
export const PRODUCT_KINDS = ["plan", "credential", "account", "service", "api_package"];
export const DELIVERY_MODES = ["instant", "admin_fulfill", "user_self_connect"];

// Story 2.31: external product source marker. Defined locally (NOT imported from
// catalogSync.js) to keep the repo layer free of store-layer dependencies and avoid
// a circular import (catalogSync → markupEngine → markupRulesRepo).
const EXTERNAL_SOURCE = "external_telegram_store";

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
    // Story 2.31: pricing + publish fields (null for local products)
    supplierPrice: row.supplierPrice ?? null,
    retailPrice: row.retailPrice ?? null,
    expectedMargin: row.expectedMargin ?? null,
    isPublished: row.isPublished === 1 || row.isPublished === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Liệt kê tất cả products đang active.
 * Dùng cho /products handler và GET /api/store/products (AC2).
 *
 * Story 2.31 invariant: external products require isPublished=1 to appear, but
 * publishProduct() always sets isActive=1 when isPublished=1 — so filtering on
 * isActive=1 alone is sufficient for BOTH local and external products. We do NOT
 * add `isPublished IS NOT NULL` or `source='local'` here (that would break local
 * products, whose isPublished is null). See markupEngine.publishProduct/unpublishProduct.
 *
 * Story 2.34 (AC3): hide external products whose supplier source is `unhealthy`
 * (2+ consecutive sync failures) — checkout would be fail-closed anyway (QĐ2), so the
 * catalog must not advertise them. LEFT JOIN keeps local products (no supplierSourceId,
 * thus no joined row) and external products from healthy/degraded sources visible.
 */
export async function listActiveProducts() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT p.* FROM products p
     LEFT JOIN supplierSources s ON s.id = p.supplierSourceId
     WHERE p.isActive = 1
       AND (s.id IS NULL OR s.status != 'unhealthy')
     ORDER BY p.name ASC`
  );
  return rows.map(rowToProduct);
}

/**
 * Liệt kê external products (published + unpublished) cho admin view (Story 2.31 T6).
 * Optional filter theo supplierSourceId.
 */
export async function listExternalProducts(supplierId) {
  const db = await getAdapter();
  const rows = supplierId
    ? db.all(
        `SELECT * FROM products WHERE source = ? AND supplierSourceId = ? ORDER BY name ASC`,
        [EXTERNAL_SOURCE, supplierId]
      )
    : db.all(
        `SELECT * FROM products WHERE source = ? ORDER BY name ASC`,
        [EXTERNAL_SOURCE]
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
    // Story 2.31 (Review patch MAJOR): external product priceCredits là nguồn truth của
    // applyMarkupToProduct (= retailPrice). Cho ghi trực tiếp sẽ phá invariant
    // priceCredits === retailPrice → checkout charge sai trong khi display giữ giá cũ.
    // Scope hẹp theo source — local product (2.28) vẫn set priceCredits tự do.
    if (existing.source === EXTERNAL_SOURCE) {
      throw new Error(
        "updateProduct: external product không được set priceCredits trực tiếp — dùng applyMarkupToProduct"
      );
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
    // Story 2.31 (Review CRITICAL #4): enforce invariant isPublished=1 ⇒ isActive=1.
    // External products must change visibility ONLY via publishProduct/unpublishProduct,
    // never by setting isActive directly (would leave isPublished=1 + isActive=0 skew).
    // Guard is scoped narrowly to external source — local product CRUD (story 2.28)
    // continues to set isActive freely.
    if (existing.source === EXTERNAL_SOURCE) {
      throw new Error(
        "updateProduct: external product không được set isActive trực tiếp — dùng publishProduct/unpublishProduct"
      );
    }
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
