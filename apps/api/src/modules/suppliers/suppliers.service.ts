import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  db,
  eq,
  and,
  or,
  sql,
  desc,
  supplierSources,
  products,
  type DbOrTx,
} from '@repo/database';
import type {
  SupplierSourceDto,
  CreateSupplierSourceDto,
  UpdateSupplierSourceDto,
} from '@repo/shared-types';

@Injectable()
export class SuppliersService {
  async listSuppliers(opts?: { limit?: number; offset?: number; search?: string }, tx: DbOrTx = db): Promise<SupplierSourceDto[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.offset ?? 0;
    const search = opts?.search?.trim();

    let query = tx
      .select()
      .from(supplierSources)
      .orderBy(desc(supplierSources.createdAt))
      .limit(limit)
      .offset(offset)
      .$dynamic();

    if (search) {
      query = query.where(
        or(
          sql`${supplierSources.name} ILIKE ${'%' + search + '%'}`,
          sql`${supplierSources.type} ILIKE ${'%' + search + '%'}`,
        ),
      );
    }

    const allSuppliers = await query;

    if (allSuppliers.length === 0) {
      return [];
    }

    // Aggregate linked product counts per supplier
    const linkedCounts = await tx
      .select({
        supplierSourceId: products.supplierSourceId,
        count: sql<number>`count(*)::int`,
      })
      .from(products)
      .where(eq(products.isActive, true))
      .groupBy(products.supplierSourceId);

    const countMap = new Map<string, number>();
    for (const row of linkedCounts) {
      if (row.supplierSourceId) {
        countMap.set(row.supplierSourceId, Number(row.count));
      }
    }

    return allSuppliers.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      targetUrl: s.targetUrl,
      configCredentials: s.configCredentials as Record<string, any> | null,
      markupPercentage: s.markupPercentage,
      markupFixedVnd: s.markupFixedVnd,
      isActive: s.isActive,
      linkedProductsCount: countMap.get(s.id) ?? 0,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  }

  async getSupplierById(id: string, tx: DbOrTx = db): Promise<SupplierSourceDto> {
    const [supplier] = await tx
      .select()
      .from(supplierSources)
      .where(eq(supplierSources.id, id))
      .limit(1);

    if (!supplier) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SUPPLIER_NOT_FOUND',
        message: `Supplier ${id} not found`,
      });
    }

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.supplierSourceId, id), eq(products.isActive, true)));

    return {
      id: supplier.id,
      name: supplier.name,
      type: supplier.type,
      targetUrl: supplier.targetUrl,
      configCredentials: supplier.configCredentials as Record<string, any> | null,
      markupPercentage: supplier.markupPercentage,
      markupFixedVnd: supplier.markupFixedVnd,
      isActive: supplier.isActive,
      linkedProductsCount: Number(countRow?.count ?? 0),
      createdAt: supplier.createdAt.toISOString(),
      updatedAt: supplier.updatedAt.toISOString(),
    };
  }

  async createSupplier(dto: CreateSupplierSourceDto, tx: DbOrTx = db): Promise<SupplierSourceDto> {
    if (!dto.name || typeof dto.name !== 'string' || dto.name.trim().length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Supplier name is required',
      });
    }

    const markupPct = dto.markupPercentage ?? '0.00';
    if (!/^\d+(\.\d{1,2})?$/.test(markupPct)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupPercentage must be a non-negative numeric string',
      });
    }

    const markupFixed = dto.markupFixedVnd ?? '0.00';
    if (!/^\d+(\.\d{1,2})?$/.test(markupFixed)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupFixedVnd must be a non-negative numeric string',
      });
    }

    if (dto.configCredentials !== undefined && dto.configCredentials !== null && typeof dto.configCredentials !== 'object') {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'configCredentials must be a valid JSON object',
      });
    }

    const [created] = await tx
      .insert(supplierSources)
      .values({
        name: dto.name.trim(),
        type: dto.type ?? 'CONFIG_POOL',
        targetUrl: dto.targetUrl ?? null,
        configCredentials: dto.configCredentials ?? null,
        markupPercentage: markupPct,
        markupFixedVnd: markupFixed,
        isActive: dto.isActive ?? true,
      })
      .returning();

    return {
      id: created.id,
      name: created.name,
      type: created.type,
      targetUrl: created.targetUrl,
      configCredentials: created.configCredentials as Record<string, any> | null,
      markupPercentage: created.markupPercentage,
      markupFixedVnd: created.markupFixedVnd,
      isActive: created.isActive,
      linkedProductsCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  async updateSupplier(id: string, dto: UpdateSupplierSourceDto, tx: DbOrTx = db): Promise<SupplierSourceDto> {
    const [existing] = await tx
      .select()
      .from(supplierSources)
      .where(eq(supplierSources.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SUPPLIER_NOT_FOUND',
        message: `Supplier ${id} not found`,
      });
    }

    if (dto.name !== undefined && (typeof dto.name !== 'string' || dto.name.trim().length === 0)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'Supplier name cannot be empty',
      });
    }

    if (dto.markupPercentage !== undefined && !/^\d+(\.\d{1,2})?$/.test(dto.markupPercentage)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupPercentage must be a non-negative numeric string',
      });
    }

    if (dto.markupFixedVnd !== undefined && !/^\d+(\.\d{1,2})?$/.test(dto.markupFixedVnd)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_SUPPLIER_PAYLOAD',
        message: 'markupFixedVnd must be a non-negative numeric string',
      });
    }

    if (dto.isActive === false && existing.isActive === true) {
      const [activeProducts] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(and(eq(products.supplierSourceId, id), eq(products.isActive, true)));
      const count = Number(activeProducts?.count ?? 0);
      if (count > 0) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'SUPPLIER_HAS_LINKED_PRODUCTS',
          message: `Cannot deactivate supplier with ${count} active linked products. Deactivate or reassign products first.`,
        });
      }
    }

    const [updated] = await tx
      .update(supplierSources)
      .set({
        name: dto.name !== undefined ? dto.name.trim() : existing.name,
        type: dto.type !== undefined ? dto.type : existing.type,
        targetUrl: dto.targetUrl !== undefined ? dto.targetUrl : existing.targetUrl,
        configCredentials:
          dto.configCredentials !== undefined ? dto.configCredentials : existing.configCredentials,
        markupPercentage:
          dto.markupPercentage !== undefined ? dto.markupPercentage : existing.markupPercentage,
        markupFixedVnd:
          dto.markupFixedVnd !== undefined ? dto.markupFixedVnd : existing.markupFixedVnd,
        isActive: dto.isActive !== undefined ? dto.isActive : existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(supplierSources.id, id))
      .returning();

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.supplierSourceId, id), eq(products.isActive, true)));

    return {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      targetUrl: updated.targetUrl,
      configCredentials: updated.configCredentials as Record<string, any> | null,
      markupPercentage: updated.markupPercentage,
      markupFixedVnd: updated.markupFixedVnd,
      isActive: updated.isActive,
      linkedProductsCount: Number(countRow?.count ?? 0),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async deleteSupplier(id: string, tx: DbOrTx = db): Promise<void> {
    const [existing] = await tx
      .select()
      .from(supplierSources)
      .where(eq(supplierSources.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SUPPLIER_NOT_FOUND',
        message: `Supplier ${id} not found`,
      });
    }

    const [activeProducts] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.supplierSourceId, id), eq(products.isActive, true)));

    const count = Number(activeProducts?.count ?? 0);
    if (count > 0) {
      throw new ConflictException({
        statusCode: 409,
        errorCode: 'SUPPLIER_HAS_LINKED_PRODUCTS',
        message: `Cannot delete supplier with ${count} active linked products. Deactivate or reassign products first.`,
      });
    }

    await tx
      .update(supplierSources)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(supplierSources.id, id));
  }
}
