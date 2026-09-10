import { Body, Controller, Post, UseGuards, BadRequestException, HttpCode } from '@nestjs/common';
import { VietQRWebhookGuard } from './vietqr-webhook.guard';
import { BitcartWebhookGuard } from './bitcart-webhook.guard';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import type { TelegramUserDto, CreateVietQrPaymentDto, CreateBitcartPaymentDto } from '@repo/shared-types';

const MIN_TOPUP_AMOUNT = 10000;
const DEFAULT_MAX_TOPUP_VND = 50_000_000;

function getMaxTopupVnd(): number {
  const raw = Number(process.env.MAX_TOPUP_VND);
  return Number.isFinite(raw) && raw >= MIN_TOPUP_AMOUNT ? Math.floor(raw) : DEFAULT_MAX_TOPUP_VND;
}

function validateTopupAmount(amount: number): void {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < MIN_TOPUP_AMOUNT) {
    throw new BadRequestException({
      errorCode: 'INVALID_TOPUP_AMOUNT',
      message: `Top-up amount must be an integer greater than or equal to ${MIN_TOPUP_AMOUNT} VND`,
    });
  }
  const max = getMaxTopupVnd();
  if (amount > max) {
    throw new BadRequestException({
      errorCode: 'INVALID_TOPUP_AMOUNT',
      message: `Top-up amount must not exceed ${max} VND`,
    });
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('topup/vietqr')
  @UseGuards(TelegramAuthGuard)
  async createVietQrPayment(
    @CurrentUser() user: TelegramUserDto,
    @Body() body: CreateVietQrPaymentDto,
  ) {
    if (!body || typeof body !== 'object' || body.amount === undefined) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: 'Top-up amount is required',
      });
    }
    validateTopupAmount(body.amount);

    const payment = await this.paymentsService.createVietQrPayment(user, body.amount);
    return { ok: true, payment };
  }

  @Post('topup/bitcart')
  @UseGuards(TelegramAuthGuard)
  async createBitcartPayment(
    @CurrentUser() user: TelegramUserDto,
    @Body() body: CreateBitcartPaymentDto,
  ) {
    if (!body || typeof body !== 'object' || body.amount === undefined) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_AMOUNT',
        message: 'Top-up amount is required',
      });
    }
    if (
      typeof body.coin !== 'string' || !body.coin.trim() ||
      typeof body.network !== 'string' || !body.network.trim()
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOPUP_REQUEST',
        message: 'Coin and network are required',
      });
    }
    validateTopupAmount(body.amount);

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
