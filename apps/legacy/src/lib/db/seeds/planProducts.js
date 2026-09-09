/**
 * planProducts seed — tạo plan products trong store từ plans table (Story 2.36, T7)
 *
 * Idempotent: skip nếu product với targetId === plan.id và kind === "plan" đã tồn tại.
 * Chạy: node -e "import('./src/lib/db/seeds/planProducts.js').then(m => m.seedPlanProducts())"
 */

import { listPlans } from "../repos/plansRepo.js";
import { createProduct } from "../repos/productsRepo.js";
import { getAdapter } from "../driver.js";

export async function seedPlanProducts() {
  const plans = await listPlans({ activeOnly: true });
  if (!plans.length) {
    console.log("[seed/planProducts] Không có plan active nào.");
    return { created: 0, skipped: 0 };
  }

  const adapter = await getAdapter();
  let created = 0;
  let skipped = 0;

  for (const plan of plans) {
    const existing = adapter.get(
      `SELECT id FROM products WHERE kind = 'plan' AND targetType = '9router_plan' AND targetId = ?`,
      [plan.id]
    );
    if (existing) {
      skipped++;
      continue;
    }

    await createProduct({
      name: plan.displayName || plan.name,
      kind: "plan",
      priceCredits: plan.priceCredits,
      deliveryMode: "instant",
      targetType: "9router_plan",
      targetId: plan.id,
      description: plan.description || `Gói ${plan.displayName || plan.name} — ${plan.durationDays} ngày`,
      stock: null,
      isActive: true,
    });
    created++;
    console.log(`[seed/planProducts] Tạo product cho plan: ${plan.displayName || plan.name}`);
  }

  console.log(`[seed/planProducts] Done: ${created} created, ${skipped} skipped.`);
  return { created, skipped };
}
