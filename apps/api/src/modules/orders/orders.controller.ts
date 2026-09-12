import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import type {
  CheckoutRequestDto,
  CheckoutResponseDto,
  OrderDto,
  TelegramUserDto,
} from '@repo/shared-types';

@UseGuards(TelegramAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async getMyOrders(@CurrentUser() telegramUser: TelegramUserDto): Promise<OrderDto[]> {
    return this.ordersService.getMyOrders(telegramUser);
  }

  @Get(':id')
  async getOrderById(
    @CurrentUser() telegramUser: TelegramUserDto,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<OrderDto> {
    const order = await this.ordersService.getOrderByIdForUser(telegramUser, id);
    if (!order) {
      throw new NotFoundException({
        errorCode: 'ORDER_NOT_FOUND',
        message: `Order ${id} not found`,
      });
    }
    return order;
  }

  @Post('checkout')
  async checkout(
    @CurrentUser() telegramUser: TelegramUserDto,
    @Body() body: CheckoutRequestDto,
  ): Promise<CheckoutResponseDto> {
    if (
      !body ||
      typeof body.productId !== 'string' ||
      body.productId.trim() === '' ||
      typeof body.idempotencyKey !== 'string' ||
      body.idempotencyKey.trim() === '' ||
      body.idempotencyKey.length > 100
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_CHECKOUT_PAYLOAD',
        message: 'productId and idempotencyKey (1-100 chars) are required',
      });
    }

    return this.ordersService.checkout(
      telegramUser,
      body.productId,
      body.idempotencyKey,
    );
  }
}
