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
  BadRequestException,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { ProductsService } from './products.service';
import {
  ProductSourcingMode,
  type AdminProductDto,
  type CreateProductDto,
  type UpdateProductDto,
} from '@repo/shared-types';

@UseGuards(AdminRoleGuard)
@Controller('admin/products')
export class AdminProductsController {
  constructor(
    @Inject(ProductsService)
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  async listAdminProducts(): Promise<{ ok: boolean; products: AdminProductDto[] }> {
    const products = await this.productsService.listAdminProducts();
    return { ok: true, products };
  }

  @Get(':id')
  async getAdminProduct(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ ok: boolean; product: AdminProductDto }> {
    const product = await this.productsService.getAdminProductById(id);
    return { ok: true, product };
  }

  @Post()
  async createProduct(
    @Body() body: CreateProductDto,
  ): Promise<{ ok: boolean; product: AdminProductDto }> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Request body is required',
      });
    }

    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product title is required',
      });
    }

    if (!body.price || typeof body.price !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.price)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product price must be a valid non-negative numeric string',
      });
    }

    if (!['IN_HOUSE', 'EXTERNAL', 'HYBRID'].includes(body.sourcingMode)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Invalid sourcingMode',
      });
    }

    if (
      (body.sourcingMode === ProductSourcingMode.EXTERNAL || body.sourcingMode === ProductSourcingMode.HYBRID) &&
      (!body.supplierSourceId || typeof body.supplierSourceId !== 'string' || body.supplierSourceId.trim() === '')
    ) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'supplierSourceId is required for EXTERNAL or HYBRID products',
      });
    }

    if (body.upstreamCost !== undefined && body.upstreamCost !== null && (typeof body.upstreamCost !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.upstreamCost))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'upstreamCost must be a valid non-negative numeric string',
      });
    }

    if (body.maxUpstreamCost !== undefined && body.maxUpstreamCost !== null && (typeof body.maxUpstreamCost !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.maxUpstreamCost))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'maxUpstreamCost must be a valid non-negative numeric string',
      });
    }

    const product = await this.productsService.createProduct(body);
    return { ok: true, product };
  }

  @Patch(':id')
  async updateProduct(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: UpdateProductDto,
  ): Promise<{ ok: boolean; product: AdminProductDto }> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Request body is required',
      });
    }

    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product title cannot be empty',
      });
    }

    if (body.price !== undefined && (typeof body.price !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.price))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product price must be a valid non-negative numeric string',
      });
    }

    if (body.sourcingMode !== undefined && !['IN_HOUSE', 'EXTERNAL', 'HYBRID'].includes(body.sourcingMode)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Invalid sourcingMode',
      });
    }

    if (body.upstreamCost !== undefined && body.upstreamCost !== null && (typeof body.upstreamCost !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.upstreamCost))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'upstreamCost must be a valid non-negative numeric string',
      });
    }

    if (body.maxUpstreamCost !== undefined && body.maxUpstreamCost !== null && (typeof body.maxUpstreamCost !== 'string' || !/^\d+(\.\d{1,2})?$/.test(body.maxUpstreamCost))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'maxUpstreamCost must be a valid non-negative numeric string',
      });
    }

    const product = await this.productsService.updateProduct(id, body);
    return { ok: true, product };
  }

  @Delete(':id')
  async deleteProduct(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query('hard') hard?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const isHard = hard === 'true';
    await this.productsService.deleteProduct(id, isHard);
    return {
      ok: true,
      message: isHard ? 'Product permanently deleted' : 'Product deactivated',
    };
  }
}
