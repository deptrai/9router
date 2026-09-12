import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PriceSyncService } from './price-sync.service';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import type { CatalogResponseDto, SyncPricesResponseDto } from '@repo/shared-types';

/**
 * Products endpoint:
 * - GET /api/products: Public storefront catalog. No auth required.
 * - POST /api/products/sync-prices: Protected by TelegramAuthGuard & AdminRoleGuard.
 */
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly priceSyncService: PriceSyncService,
  ) {}

  @Get()
  async listCatalog(): Promise<CatalogResponseDto> {
    const products = await this.productsService.listCatalog();
    return { ok: true, products };
  }

  @Post('sync-prices')
  @UseGuards(AdminRoleGuard)
  async syncPrices(): Promise<SyncPricesResponseDto> {
    return { ok: true, summary: await this.priceSyncService.syncAll() };
  }
}
