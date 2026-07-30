import { NextResponse } from "next/server";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";
import { getUserByTelegramId, createUser, updateUser } from "@/lib/db/repos/usersRepo.js";
import { getProductById } from "@/lib/db/repos/productsRepo.js";
import { getDecryptedPayload } from "@/lib/db/repos/credentialsRepo.js";
import { storeCheckout, CheckoutError } from "@/lib/store/storeCheckout.js";
import { externalCheckout, ExternalCheckoutError } from "@/lib/store/externalCheckout.js";
import { EXTERNAL_SOURCE } from "@/lib/store/catalogSync.js";

export const dynamic = "force-dynamic";

const CHECKOUT_ERROR_MESSAGES = {
  PRODUCT_NOT_FOUND: "Sản phẩm không tồn tại.",
  INACTIVE: "Sản phẩm đã ngừng bán.",
  OUT_OF_STOCK: "Sản phẩm đã hết hàng.",
  NO_INVENTORY: "Sản phẩm tạm hết hàng.",
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

async function getOrCreateUser(telegramUser) {
  const telegramId = String(telegramUser.id);
  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    const displayName =
      [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim() ||
      telegramUser.username ||
      `tg_${telegramId}`;
    const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
    user = await createUser(placeholderEmail, null, displayName);
    await updateUser(user.id, { telegramId });
  }
  return user;
}

export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { initData, productId, quantity = 1, requestId } = body || {};
    if (!initData || typeof initData !== "string" || !productId) {
      return NextResponse.json({ error: "initData and productId are required" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const telegramUser = result.user;
    const telegramId = String(telegramUser.id);
    const user = await getOrCreateUser(telegramUser);

    const product = await getProductById(productId);
    if (!product) {
      return NextResponse.json({ error: "Sản phẩm không tồn tại." }, { status: 404 });
    }

    const effectiveRequestId = requestId || `auto:${Date.now()}`;
    const idempotencyKey = `tgmini:${telegramId}:${productId}:${result.queryId || "none"}:${effectiveRequestId}`;
    const isExternal = product.source === EXTERNAL_SOURCE;

    if (isExternal) {
      const { order, alreadyProcessed, paymentMode } = await externalCheckout(
        user.id,
        productId,
        { quantity, idempotencyKey }
      );
      const message = paymentMode === "auto_fulfill"
        ? "Đã thanh toán, đang tìm supplier tự động..."
        : "Đơn hàng đã được tạo. Đang xử lý với nhà cung cấp.";
      return NextResponse.json({ success: true, order, alreadyProcessed, paymentMode, message });
    }

    const { order, alreadyProcessed, deliveredCredentialIds, entitlementId, planActivation, planActivationError } =
      await storeCheckout(user.id, productId, { quantity, idempotencyKey });

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
      planActivationError: planActivationError || null,
      message: order.status === "fulfilled" ? "Mua thành công!" : "Đơn đang chờ admin xử lý.",
    });
  } catch (e) {
    if (e instanceof ExternalCheckoutError) {
      return NextResponse.json({ error: EXTERNAL_CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại." }, { status: 400 });
    }
    if (e instanceof CheckoutError) {
      return NextResponse.json({ error: CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại." }, { status: 400 });
    }
    console.error("[api/telegram/miniapp-buy] error:", e?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
