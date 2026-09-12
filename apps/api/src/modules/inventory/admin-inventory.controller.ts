import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Inject,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { InventoryService } from './inventory.service';
import type {
  AdminInventoryItemDto,
  AdminGlobalInventorySummaryDto,
  BatchImportCredentialsDto,
  BatchImportCredentialsResponseDto,
  UpdateCredentialStatusDto,
  ListInventoryResponseDto,
  DecryptCredentialResponseDto,
} from '@repo/shared-types';

@UseGuards(AdminRoleGuard)
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(
    @Inject(InventoryService)
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * GET /api/admin/inventory/summary
   * Returns global inventory statistics across all products.
   */
  @Get('summary')
  async getGlobalSummary(): Promise<{ ok: boolean; summary: AdminGlobalInventorySummaryDto }> {
    const summary = await this.inventoryService.getGlobalInventorySummary();
    return { ok: true, summary };
  }

  /**
   * GET /api/admin/inventory/products/:productId
   * Lists inventory items for a product with pagination and status filter.
   */
  @Get('products/:productId')
  async listProductInventory(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
  ): Promise<ListInventoryResponseDto> {
    const query = {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      status: status as any,
    };
    const result = await this.inventoryService.listProductInventory(productId, query);
    return { ok: true, items: result.items, total: result.total };
  }

  /**
   * GET /api/admin/inventory/products/:productId/summary
   * Returns stock metrics for a specific product.
   */
  @Get('products/:productId/summary')
  async getProductSummary(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<{ ok: boolean; summary: any }> {
    const summary = await this.inventoryService.getStockSummary(productId);
    return { ok: true, summary };
  }

  /**
   * POST /api/admin/inventory/products/:productId/batch
   * Bulk imports credentials for a product.
   */
  @Post('products/:productId/batch')
  async batchImportCredentials(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: BatchImportCredentialsDto,
  ): Promise<BatchImportCredentialsResponseDto> {
    const result = await this.inventoryService.batchImportCredentials(
      productId,
      body.credentials || [],
    );
    return {
      ok: true,
      count: result.count,
      productId,
      addedAt: result.addedAt,
    };
  }

  /**
   * DELETE /api/admin/inventory/items/:id
   * Deletes a credential (only if AVAILABLE or DEFECTIVE).
   */
  @Delete('items/:id')
  async deleteCredential(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ ok: boolean; deleted: boolean }> {
    const deleted = await this.inventoryService.deleteCredential(id);
    return { ok: true, deleted };
  }

  /**
   * PATCH /api/admin/inventory/items/:id/status
   * Updates credential status (AVAILABLE <-> DEFECTIVE).
   */
  @Patch('items/:id/status')
  async updateCredentialStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: UpdateCredentialStatusDto,
  ): Promise<{ ok: boolean; updated: boolean }> {
    const updated = await this.inventoryService.updateCredentialStatus(id, body.status);
    return { ok: true, updated };
  }

  /**
   * GET /api/admin/inventory/items/:id/decrypt
   * Decrypts a single credential with audit logging.
   */
  @Get('items/:id/decrypt')
  async decryptCredential(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
  ): Promise<DecryptCredentialResponseDto> {
    const adminId = req.user?.id?.toString() || 'unknown';
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const credential = await this.inventoryService.decryptSingleCredential(id, adminId, ipAddress);
    return { ok: true, credential };
  }
}
