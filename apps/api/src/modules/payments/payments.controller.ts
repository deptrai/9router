import { Body, Controller, Post, UseGuards, BadRequestException, HttpCode } from '@nestjs/common';
import { VietQRWebhookGuard } from './vietqr-webhook.guard';
import { BitcartWebhookGuard } from './bitcart-webhook.guard';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import type { TelegramUserDto, CreateVietQrPaymentDto, CreateBitcartPaymentDto } from '@repo/shared-types';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('topup/vietqr')
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

  @Post('topup/bitcart')
  @UseGuards(TelegramAuthGuard)
  async createBitcartPayment(
    @CurrentUser() user: TelegramUserDto,
    @Body() body: CreateBitcartPaymentDto,
  ) {
    if (!body || typeof body !== 'object' ||
      !Number.isFinite(body.amount) || !Number.isInteger(body.amount) || body.amount < 10000 ||
      typeof body.coin !== 'string' || !body.coin.trim() ||
      typeof body.network !== 'string' || !body.network.trim()
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_REQUEST',
        message: 'Top-up amount, coin and network are required',
      });
    }

    const payment = await this.paymentsService.createBitcartPayment(
      user,
      body.amount,
      body.coin.trim().toUpperCase(),
      body.network.trim().toUpperCase(),
    );
    return { ok: true, payment };
  }

  @Post(['vietqr/webhook', 'topup/vietqr/webhook'])
  @HttpCode(200)
  @UseGuards(VietQRWebhookGuard)
  async processVietQRWebhook(@Body() body: any) {
    const result = await this.paymentsService.processVietQRWebhook(body);
    return result;
  }

  @Post(['bitcart/webhook', 'topup/bitcart/webhook'])
  @HttpCode(200)
  @UseGuards(BitcartWebhookGuard)
  async processBitcartWebhook(@Body() body: any) {
    const result = await this.paymentsService.processBitcartWebhook(body);
    return result;
  }
}
