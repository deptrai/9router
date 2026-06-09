const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const NUMERIC_FIELDS = ["rpm", "quota5h", "quotaWeekly", "sortOrder"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message) {
  return { ok: false, error: message };
}

function validateNonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return `${field} must be a finite non-negative integer`;
  }
  return null;
}

function validateNonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${field} must be a finite non-negative number`;
  }
  return null;
}

function validatePositiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return `${field} must be a finite positive integer`;
  }
  return null;
}

function hasValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validatePerModelLimits(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) return "perModelLimits must be an object or null";

  for (const [model, limits] of Object.entries(value)) {
    if (!model || !isPlainObject(limits)) {
      return "perModelLimits entries must be objects";
    }
    for (const field of ["q5h", "qWeekly"]) {
      if (limits[field] !== undefined) {
        const message = validateNonNegativeInteger(limits[field], `perModelLimits.${model}.${field}`);
        if (message) return message;
      }
    }
  }
  return null;
}

export function validatePlanInput(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return invalid("Request body must be an object");

  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return invalid("name is required");
    const name = body.name.trim();
    if (!partial && !SLUG_RE.test(name)) {
      return invalid("name must be a slug between 2 and 64 characters");
    }
    out.name = name;
  }

  if (body.displayName !== undefined) {
    out.displayName = body.displayName === null ? null : String(body.displayName).trim() || null;
  }

  for (const field of NUMERIC_FIELDS) {
    if (!partial || body[field] !== undefined) {
      const value = body[field] === undefined ? 0 : body[field];
      const message = validateNonNegativeInteger(value, field);
      if (message) return invalid(message);
      out[field] = value;
    }
  }

  if (!partial || body.priceCredits !== undefined) {
    const value = body.priceCredits === undefined ? 0 : body.priceCredits;
    const message = validateNonNegativeNumber(value, "priceCredits");
    if (message) return invalid(message);
    out.priceCredits = value;
  }

  if (!partial || body.durationDays !== undefined) {
    const value = body.durationDays === undefined ? 30 : body.durationDays;
    const message = validatePositiveInteger(value, "durationDays");
    if (message) return invalid(message);
    out.durationDays = value;
  }

  if (!partial || body.perModelLimits !== undefined) {
    const value = body.perModelLimits === undefined ? null : body.perModelLimits;
    const message = validatePerModelLimits(value);
    if (message) return invalid(message);
    out.perModelLimits = value;
  }

  if (!partial || body.isActive !== undefined) {
    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
      return invalid("isActive must be a boolean");
    }
    out.isActive = body.isActive === undefined ? true : body.isActive;
  }

  return { ok: true, data: out };
}

export function validatePlanExpiry(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim()) return invalid("planExpiresAt must be an ISO date or null");
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(trimmed);
  if (!match) return invalid("planExpiresAt must be a valid ISO date or null");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!hasValidCalendarDate(year, month, day)) return invalid("planExpiresAt must be a valid ISO date or null");
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return invalid("planExpiresAt must be a valid ISO date or null");
  return { ok: true, value: date.toISOString() };
}
