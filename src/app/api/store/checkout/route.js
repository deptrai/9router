import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getProductById } from "@/lib/db/repos/productsRepo.js";
import { storeCheckout, CheckoutError } from "@/lib/store/storeCheckout.js";
import { externalCheckout, ExternalCheckoutError } from "@/lib/store/externalCheckout.js";
import { EXTERNAL_SOURCE } from "@/lib/store/catalogSync.js";
import { getDecryptedPayload } from "@/lib/db/repos/credentialsRepo.js";

const CHECKOUT_ERROR_MESSAGES = {
  PRODUCT_NOT_FOUND: "Sản phẩm không tồn tại.",
  INACTIVE: "Sản phẩm đã ngừng bán.",
  OUT_OF_STOCK: "Sản phẩm đã hết hàng.",
  NO_INVENTORY: "❌ Sản phẩm tạm hết hàng.",
  INSUFFICIENT_CREDITS: "Số dư không đủ.",
  INVALID_QUANTITY: "Số lượng không hợp lệ.",
};

const EXTERNAL_CHECKOUT_ERROR_MESSAGES = {
  NOT_EXTERNAL: "Sản phẩm không hợp lệ.",
  NOT_PUBLISHED: "Sản phẩm chưa được đăng bán hoặc đã ngừng bán.",
  MARGIN_VIOLATION: "Sản phẩm chưa có giá bán hợp lệ — liên hệ admin.",
  VENDOR_MODE_UNSUPPORTED: "Phương thức thanh toán chưa được hỗ trợ — liên hệ admin.",
  PRODUCT_DISABLED: "Sản phẩm tạm ngừng bán — liên hệ admin.",
  SUPPLIER_NOT_FOUND: "Không tìm thấy nguồn cung cấp — liên hệ admin.",
};

export async function POST(request) {
  const session = await getDashboardAuthSession(request);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { productId, quantity = 1 } = body;
  if (!productId) {
    return NextResponse.json({ error: "productId is required" }, { status: 400 });
  }

  try {
    const product = await getProductById(productId);
    if (!product) {
      return NextResponse.json({ error: "Sản phẩm không tồn tại." }, { status: 404 });
    }

    const idempotencyKey = `web:${session.userId}:${productId}:${Date.now()}`;
    const isExternal = product.source === EXTERNAL_SOURCE;

    if (isExternal) {
      const { order, alreadyProcessed } = await externalCheckout(
        session.userId,
        productId,
        { quantity, idempotencyKey }
      );
      return NextResponse.json({
        success: true,
        order,
        alreadyProcessed,
        message: "Đơn hàng đã được tạo. Đang xử lý với nhà cung cấp.",
      });
    }

    const { order, alreadyProcessed, deliveredCredentialIds, entitlementId, planActivation } = await storeCheckout(
      session.userId,
      productId,
      { quantity, idempotencyKey }
    );

    // Load credentials if delivered
    let credentials = [];
    if (deliveredCredentialIds?.length) {
      for (const credId of deliveredCredentialIds) {
        try {
          const payload = await getDecryptedPayload(credId);
          credentials.push(payload);
        } catch {}
      }
    }

    return NextResponse.json({
      success: true,
      order,
      alreadyProcessed,
      credentials,
      entitlementId,
      planActivation,
      message: order.status === "fulfilled" ? "Mua thành công!" : "Đơn đang chờ admin xử lý.",
    });
  } catch (e) {
    if (e instanceof ExternalCheckoutError) {
      return NextResponse.json({ error: EXTERNAL_CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại." }, { status: 400 });
    }
    if (e instanceof CheckoutError) {
      return NextResponse.json({ error: CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại." }, { status: 400 });
    }
    console.error("[web/checkout] error:", e.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
