import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Inject,
  ParseUUIDPipe,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { OrdersService } from './orders.service';
import type {
  AdminOrderListItemDto,
  AdminOrderDetailDto,
  AdminManualRefundDto,
  AdminManualRefundResponseDto,
  ListAdminOrdersResponseDto,
  OrderStatus,
} from '@repo/shared-types';

@UseGuards(AdminRoleGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    @Inject(OrdersService)
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * GET /api/admin/orders
   * Lists customer orders with pagination, status filter, and keyword search.
   */
  @Get()
  async listOrders(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('productId') productId?: string,
  ): Promise<ListAdminOrdersResponseDto> {
    // Validate and sanitize pagination params — reject NaN to avoid Postgres errors
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const parsedOffset = offset ? parseInt(offset, 10) : 0;
    const safeLimit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 50 : Math.min(parsedLimit, 100);
    const safeOffset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

    // Validate productId as UUID v4 when provided
    if (productId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId.trim())) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_ID',
        message: 'productId must be a valid UUID v4',
      });
    }

    const query = {
      limit: safeLimit,
      offset: safeOffset,
      status: status as OrderStatus,
      search: search?.trim() || undefined,
      productId: productId?.trim() || undefined,
    };

    const result = await this.ordersService.listAdminOrders(query);
    return {
      ok: true,
      orders: result.orders,
      total: result.total,
    };
  }

  /**
   * GET /api/admin/orders/:id
   * Retrieves full details for an order including customer info, product info,
   * supplier order traces, and related ledger transactions.
   */
  @Get(':id')
  async getOrderDetail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ ok: boolean; order: AdminOrderDetailDto }> {
    const order = await this.ordersService.getAdminOrderDetail(id);
    return {
      ok: true,
      order,
    };
  }

  /**
   * POST /api/admin/orders/:id/reveal-credential
   * Decrypts and returns the plaintext delivered credential for audit/debugging.
   * Logged via [AUDIT] tag for tracking admin access.
   */
  @Post(':id/reveal-credential')
  async revealCredential(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
  ): Promise<{ ok: boolean; plaintext: string }> {
    const adminId = String(req.user?.id ?? 'web-admin');
    return this.ordersService.revealAdminCredential(id, adminId);
  }

  /**
   * POST /api/admin/orders/:id/refund
   * Triggers an atomic manual refund for an order in PAID, SOURCING, or FULFILLED status.
   */
  @Post(':id/refund')
  async refundOrder(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: AdminManualRefundDto,
    @Req() req: any,
  ): Promise<AdminManualRefundResponseDto> {
    if (!body || typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_REFUND_PAYLOAD',
        message: 'A valid refund reason is required',
      });
    }

    const adminId = String(req.user?.id ?? 'web-admin');
    const result = await this.ordersService.adminManualRefund(
      id,
      adminId,
      body.reason.trim(),
      Boolean(body.markCredentialDefective),
    );

    // Fire-and-forget Telegram notification AFTER transaction commits.
    // This avoids holding FOR UPDATE locks during external HTTP calls.
    if (result.userId && result.productId) {
      void this.ordersService.notifyRefundCommit(
        result.userId,
        result.productId,
        {
          id: result.orderId,
          status: 'REFUNDED' as any,
          price: result.refundedAmount,
        } as any,
      );
    }

    // Strip internal fields from response
    return {
      ok: result.ok,
      refunded: result.refunded,
      orderId: result.orderId,
      refundedAmount: result.refundedAmount,
      refundedAt: result.refundedAt,
    };
  }
}
