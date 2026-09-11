import { Controller, Get, Post, Param, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { InventoryService } from './inventory.service';
import type {
  InventorySummaryDto,
  BatchAddCredentialsDto,
  BatchAddCredentialsResponseDto,
} from '@repo/shared-types';

@UseGuards(TelegramAuthGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('products/:productId/summary')
  async getStockSummary(
    @Param('productId') productId: string,
  ): Promise<{ ok: boolean; summary: InventorySummaryDto }> {
    const summary = await this.inventoryService.getStockSummary(productId);
    return { ok: true, summary };
  }

  @Post('products/:productId/batch')
  async addBatchCredentials(
    @Param('productId') productId: string,
    @Body() body: BatchAddCredentialsDto,
  ): Promise<BatchAddCredentialsResponseDto> {
    if (!body || !Array.isArray(body.credentials)) {
      throw new BadRequestException({
        errorCode: 'INVALID_CREDENTIALS_PAYLOAD',
        message: 'Credentials must be an array of strings',
      });
    }

    if (body.credentials.length > 500) {
      throw new BadRequestException({
        errorCode: 'BATCH_SIZE_EXCEEDED',
        message: 'Cannot ingest more than 500 credentials in a single batch',
      });
    }

    const count = await this.inventoryService.addCredentials(productId, body.credentials);
    return { ok: true, count, productId };
  }
}
