import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Inject,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { SuppliersService } from './suppliers.service';
import type {
  SupplierSourceDto,
  CreateSupplierSourceDto,
  UpdateSupplierSourceDto,
} from '@repo/shared-types';

@UseGuards(AdminRoleGuard)
@Controller('admin/suppliers')
export class SuppliersController {
  constructor(
    @Inject(SuppliersService)
    private readonly suppliersService: SuppliersService,
  ) {}

  @Get()
  async listSuppliers(): Promise<{ ok: boolean; suppliers: SupplierSourceDto[] }> {
    const suppliers = await this.suppliersService.listSuppliers();
    return { ok: true, suppliers };
  }

  @Get(':id')
  async getSupplier(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ ok: boolean; supplier: SupplierSourceDto }> {
    const supplier = await this.suppliersService.getSupplierById(id);
    return { ok: true, supplier };
  }

  @Post()
  async createSupplier(
    @Body() body: CreateSupplierSourceDto,
  ): Promise<{ ok: boolean; supplier: SupplierSourceDto }> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Request body is required',
      });
    }

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Supplier name is required',
      });
    }

    if (body.markupPercentage !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.markupPercentage)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupPercentage must be a non-negative numeric string',
      });
    }

    if (body.markupFixedVnd !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.markupFixedVnd)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupFixedVnd must be a non-negative numeric string',
      });
    }

    if (body.configCredentials !== undefined && body.configCredentials !== null && typeof body.configCredentials !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'configCredentials must be a valid JSON object',
      });
    }

    const supplier = await this.suppliersService.createSupplier(body);
    return { ok: true, supplier };
  }

  @Patch(':id')
  async updateSupplier(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: UpdateSupplierSourceDto,
  ): Promise<{ ok: boolean; supplier: SupplierSourceDto }> {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Request body is required',
      });
    }

    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Supplier name cannot be empty',
      });
    }

    if (body.markupPercentage !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.markupPercentage)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupPercentage must be a non-negative numeric string',
      });
    }

    if (body.markupFixedVnd !== undefined && !/^\d+(\.\d{1,2})?$/.test(body.markupFixedVnd)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupFixedVnd must be a non-negative numeric string',
      });
    }

    if (body.configCredentials !== undefined && body.configCredentials !== null && (typeof body.configCredentials !== 'object' || Array.isArray(body.configCredentials))) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'configCredentials must be a valid JSON object',
      });
    }

    const supplier = await this.suppliersService.updateSupplier(id, body);
    return { ok: true, supplier };
  }

  @Delete(':id')
  async deleteSupplier(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ ok: boolean; message: string }> {
    await this.suppliersService.deleteSupplier(id);
    return {
      ok: true,
      message: 'Supplier successfully deactivated',
    };
  }
}
