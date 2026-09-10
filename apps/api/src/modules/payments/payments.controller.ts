import { Body, Controller, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { VietQRWebhookGuard } from './vietqr-webhook.guard';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import type { TelegramUserDto } from '@repo/shared-types';
import type { CreateVietQrPaymentDto } from '@repo/shared-types';

@Controller('payments/topup')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('vietqr')
  @UseGuards(TelegramAuthGuard)
  async createVietQrPayment(
    @CurrentUser() user: TelegramUserDto,
    @Body() body: CreateVietQrPaymentDto,
  ) {
    if (!body || typeof body !== 'object' || !Number.isFinite(body.amount) || !Number.isInteger(body.amount) || body.amount < 10000) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: 'Top-up amount must be an integer greater than or equal to 10000 VND',
      });
    }

    const payment = await this.paymentsService.createVietQrPayment(user, body.amount);
    return { ok: true, payment };
  }

  @Post('vietqr/webhook')
  @UseGuards(VietQRWebhookGuard)
  async processVietQRWebhook(@Body() body: any) {
    const result = await this.paymentsService.processVietQRWebhook(body);
    return result;
  }
}
