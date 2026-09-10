import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
    const payment = await this.paymentsService.createVietQrPayment(user, body.amount);
    return { ok: true, payment };
  }
}
