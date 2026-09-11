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
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured — skipping order confirmation');
      return;
    }

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

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: String(telegramId),
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
          `Telegram sendMessage failed: HTTP ${res.status} ${errBody}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Telegram sendMessage error: ${err?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Send alert message to store admin via Telegram Bot API.
   * Fire-and-forget: never throws — notification failure must not break job execution.
   */
  async sendAdminAlert(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured — skipping admin alert');
      return;
    }

    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
    if (!adminChatId) {
      this.logger.warn('TELEGRAM_ADMIN_CHAT_ID not configured — skipping admin alert');
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: adminChatId,
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
          `Telegram sendAdminAlert failed: HTTP ${res.status} ${errBody}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Telegram sendAdminAlert error: ${err?.message ?? String(err)}`,
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
