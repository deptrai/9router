import { Injectable, Logger } from '@nestjs/common';
import type { OrderDto } from '@repo/shared-types';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  /**
   * Send order confirmation message to the buyer via Telegram Bot API.
   * Fire-and-forget: never throws — notification failure must not break checkout.
   */
  async sendOrderConfirmation(
    telegramId: number,
    order: OrderDto,
    productTitle: string,
  ): Promise<void> {
    const orderShortId = order.id.slice(0, 8);
    const credential = order.deliveredCredential ?? '';

    const text = [
      '🎉 <b>Mua hàng thành công!</b>',
      `📦 Sản phẩm: ${escapeHtml(productTitle)}`,
      `🆔 Đơn hàng: #${orderShortId}`,
      `💰 Giá: ${order.price} VND`,
      credential ? `🔑 Credential: <code>${escapeHtml(credential)}</code>` : '',
      'Mở Mini App → "Đơn hàng của tôi" để xem lại.',
    ]
      .filter(Boolean)
      .join('\n');

    await this.sendTelegramMessage(
      String(telegramId),
      text,
      'order confirmation',
    );
  }

  /**
   * Notify the buyer that payment was taken and the order is being sourced
   * externally. Durable Telegram record for the SOURCING state — the Mini App
   * modal is transient and disappears on close.
   * Fire-and-forget: never throws.
   */
  async sendSourcingNotice(
    telegramId: number,
    order: OrderDto,
    productTitle: string,
  ): Promise<void> {
    const orderShortId = order.id.slice(0, 8);

    const text = [
      '⏳ <b>Đơn hàng đang được xử lý</b>',
      `📦 Sản phẩm: ${escapeHtml(productTitle)}`,
      `🆔 Đơn hàng: #${orderShortId}`,
      `💰 Đã trừ: ${order.price} VND`,
      'Hệ thống đang lấy hàng từ nhà cung cấp — key sẽ được giao tự động. Nếu thất bại, tiền được hoàn lại đầy đủ.',
      'Mở Mini App → "Đơn hàng của tôi" để theo dõi.',
    ].join('\n');

    await this.sendTelegramMessage(
      String(telegramId),
      text,
      'sourcing notice',
    );
  }

  /**
   * Notify the buyer that sourcing failed and the order amount was refunded.
   * Fire-and-forget: never throws.
   */
  async sendRefundNotice(
    telegramId: number,
    order: OrderDto,
    productTitle: string,
  ): Promise<void> {
    const orderShortId = order.id.slice(0, 8);

    const text = [
      `❌ Đơn hàng #${orderShortId} — ${escapeHtml(productTitle)} không thể giao từ nhà cung cấp ngoài.`,
      `💰 ${order.price} VND đã được hoàn lại đầy đủ vào ví của bạn.`,
    ].join('\n');

    await this.sendTelegramMessage(
      String(telegramId),
      text,
      'refund notice',
    );
  }

  /**
   * Send alert message to store admin via Telegram Bot API.
   * Fire-and-forget: never throws — notification failure must not break job execution.
   */
  async sendAdminAlert(text: string): Promise<void> {
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
    if (!adminChatId) {
      this.logger.warn('TELEGRAM_ADMIN_CHAT_ID not configured — skipping admin alert');
      return;
    }

    await this.sendTelegramMessage(adminChatId, text, 'admin alert');
  }

  /**
   * Shared sendMessage call — token check + fetch + warn-only error handling.
   * Never throws.
   */
  private async sendTelegramMessage(
    chatId: string,
    text: string,
    label: string,
  ): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn(`TELEGRAM_BOT_TOKEN not configured — skipping ${label}`);
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        this.logger.warn(
          `Telegram ${label} failed: HTTP ${res.status} ${errBody}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Telegram ${label} error: ${err?.message ?? String(err)}`,
      );
    }
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
