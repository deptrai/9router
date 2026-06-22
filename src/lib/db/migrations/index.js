// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-plans.js";
import m003 from "./003-credit-ledger.js";
import m004 from "./004-credit-overflow.js";
import m005 from "./005-plan-purchase-fields.js";
import m006 from "./006-store-v2.js";
import m007 from "./007-context-safe-combos.js";
import m008 from "./008-entitlements.js";
import m009 from "./009-external-store-sources.js";
import m010 from "./010-vuz2-connection.js";
import m011 from "./011-markup-rules.js";
import m012 from "./012-supplier-orders.js";
import m013 from "./013-supplier-deliveries.js";
import m014 from "./014-affiliate.js";
import m015 from "./015-vnd-bank-payment.js";
import m016 from "./016-memo-unique-index.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
