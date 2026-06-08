import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName || null,
    rpm: row.rpm ?? 0,
    quota5h: row.quota5h ?? 0,
    quotaWeekly: row.quotaWeekly ?? 0,
    perModelLimits: parseJson(row.perModelLimits, null),
    isActive: row.isActive === 1 || row.isActive === true,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listPlans({ activeOnly = false } = {}) {
  const db = await getAdapter();
  const rows = activeOnly
    ? db.all(`SELECT * FROM plans WHERE isActive = 1 ORDER BY sortOrder ASC, name ASC`)
    : db.all(`SELECT * FROM plans ORDER BY sortOrder ASC, name ASC`);
  return rows.map(rowToPlan);
}

export async function getPlanById(id) {
  const db = await getAdapter();
  return rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
}

export async function getPlanByName(name) {
  const db = await getAdapter();
  return rowToPlan(db.get(`SELECT * FROM plans WHERE name = ?`, [name]));
}

export async function createPlan(data) {
  if (!data || !data.name || typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("createPlan: name is required and must be a non-empty string");
  }
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO plans(id, name, displayName, rpm, quota5h, quotaWeekly, perModelLimits, isActive, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.displayName ?? null,
      data.rpm ?? 0,
      data.quota5h ?? 0,
      data.quotaWeekly ?? 0,
      stringifyJson(data.perModelLimits ?? null),
      data.isActive === false ? 0 : 1,
      data.sortOrder ?? 0,
      now,
      now,
    ]
  );
  return getPlanById(id);
}

export async function updatePlan(id, data) {
  if (data && data.name !== undefined && (typeof data.name !== "string" || !data.name.trim())) {
    throw new Error("updatePlan: name cannot be empty");
  }
  const db = await getAdapter();
  const now = new Date().toISOString();
  const row = db.get(`SELECT * FROM plans WHERE id = ?`, [id]);
  if (!row) return null;
  const merged = {
    name: data.name ?? row.name,
    displayName: data.displayName !== undefined ? data.displayName : row.displayName,
    rpm: data.rpm !== undefined ? data.rpm : row.rpm,
    quota5h: data.quota5h !== undefined ? data.quota5h : row.quota5h,
    quotaWeekly: data.quotaWeekly !== undefined ? data.quotaWeekly : row.quotaWeekly,
    perModelLimits:
      data.perModelLimits !== undefined
        ? stringifyJson(data.perModelLimits)
        : row.perModelLimits,
    isActive: data.isActive !== undefined ? (data.isActive ? 1 : 0) : row.isActive,
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : row.sortOrder,
  };
  db.run(
    `UPDATE plans SET name=?, displayName=?, rpm=?, quota5h=?, quotaWeekly=?, perModelLimits=?, isActive=?, sortOrder=?, updatedAt=? WHERE id=?`,
    [merged.name, merged.displayName, merged.rpm, merged.quota5h, merged.quotaWeekly, merged.perModelLimits, merged.isActive, merged.sortOrder, now, id]
  );
  return getPlanById(id);
}

/**
 * Soft-delete: set isActive=0 so existing users referencing this plan keep their FK valid.
 * Hard-delete only when no users reference this plan.
 */
export async function deletePlan(id, { hard = false } = {}) {
  const db = await getAdapter();
  if (hard) {
    const refCount = db.get(`SELECT COUNT(*) as c FROM users WHERE planId = ?`, [id])?.c ?? 0;
    if (refCount > 0) {
      throw new Error(`Cannot hard-delete plan ${id}: ${refCount} user(s) still reference it`);
    }
    db.run(`DELETE FROM plans WHERE id = ?`, [id]);
    return { deleted: true, hard: true };
  }
  const now = new Date().toISOString();
  const exists = db.get(`SELECT 1 AS x FROM plans WHERE id = ?`, [id]);
  if (!exists) return { deleted: false, hard: false };
  db.run(`UPDATE plans SET isActive = 0, updatedAt = ? WHERE id = ?`, [now, id]);
  return { deleted: true, hard: false };
}
