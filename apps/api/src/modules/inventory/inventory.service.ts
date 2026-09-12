import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import {
  db,
  eq,
  and,
  sql,
  inArray,
  productInventory,
  products,
  type DbOrTx,
  encryptCredential,
  decryptCredential,
} from '@repo/database';
import {
  InventoryStatus,
  type InventorySummaryDto,
  type ReservedInventoryDto,
  type DeliveredInventoryDto,
  type AdminInventoryItemDto,
  type AdminGlobalInventorySummaryDto,
  type ProductStockSummaryDto,
  type ListInventoryQueryDto,
} from '@repo/shared-types';
import { maskCredential } from './utils/credential-mask.util';

@Injectable()
export class InventoryService {
  private async ensureTransaction<T>(fn: (tx: DbOrTx) => Promise<T>, runner: DbOrTx): Promise<T> {
    if (runner === db) {
      return (db as any).transaction(fn);
    }
    return fn(runner);
  }

  /**
   * Atomically reserves one AVAILABLE credential for the specified product.
   * Uses `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` to guarantee zero overselling.
   * If no credential is available, returns null immediately without blocking.
   */
  async reserveCredential(
    productId: string,
    orderId?: string | null,
    tx: DbOrTx = db,
  ): Promise<ReservedInventoryDto | null> {
    return this.ensureTransaction(async (runner) => {
      const [item] = await runner
        .select({
          id: productInventory.id,
          productId: productInventory.productId,
          status: productInventory.status,
          orderId: productInventory.orderId,
        })
        .from(productInventory)
        .where(
          and(
            eq(productInventory.productId, productId),
            eq(productInventory.status, InventoryStatus.AVAILABLE),
          ),
        )
        .for('update', { skipLocked: true })
        .limit(1);

      if (!item) {
        return null;
      }

      const [updated] = await runner
        .update(productInventory)
        .set({
          status: InventoryStatus.RESERVED,
          orderId: orderId ?? null,
        })
        .where(eq(productInventory.id, item.id))
        .returning({
          id: productInventory.id,
          productId: productInventory.productId,
          status: productInventory.status,
          orderId: productInventory.orderId,
        });

      return {
        id: updated.id,
        productId: updated.productId,
        status: updated.status as InventoryStatus,
        orderId: updated.orderId ?? null,
      };
    }, tx);
  }

  /**
   * Releases a RESERVED item back to AVAILABLE status, resetting orderId to null.
   */
  async releaseReservation(inventoryId: string, tx: DbOrTx = db): Promise<boolean> {
    const [updated] = await tx
      .update(productInventory)
      .set({
        status: InventoryStatus.AVAILABLE,
        orderId: null,
      })
      .where(
        and(
          eq(productInventory.id, inventoryId),
          eq(productInventory.status, InventoryStatus.RESERVED),
        ),
      )
      .returning({ id: productInventory.id });

    return Boolean(updated);
  }

  /**
   * Confirms a credential sale: marks status as SOLD, records soldAt timestamp,
   * associates orderId, decrypts credentialData, and returns the delivered payload.
   */
  async confirmSold(
    inventoryId: string,
    orderId: string,
    tx: DbOrTx = db,
  ): Promise<DeliveredInventoryDto> {
    return this.ensureTransaction(async (runner) => {
      const [item] = await runner
        .select()
        .from(productInventory)
        .where(eq(productInventory.id, inventoryId))
        .for('update')
        .limit(1);

      if (!item) {
        throw new NotFoundException({
          errorCode: 'INVENTORY_ITEM_NOT_FOUND',
          message: `Inventory item ${inventoryId} not found`,
        });
      }

      if (item.status === InventoryStatus.SOLD) {
        if (item.orderId === orderId) {
          // Idempotent re-delivery for the same order
          const plaintext = decryptCredential(item.credentialData);
          let soldAtIso: string;
          if (item.soldAt instanceof Date && !isNaN(item.soldAt.getTime())) {
            soldAtIso = item.soldAt.toISOString();
          } else if (typeof item.soldAt === 'string' && !isNaN(new Date(item.soldAt).getTime())) {
            soldAtIso = new Date(item.soldAt).toISOString();
          } else {
            soldAtIso = new Date().toISOString();
          }
          return {
            id: item.id,
            productId: item.productId,
            credentialData: plaintext,
            orderId: item.orderId ?? orderId,
            soldAt: soldAtIso,
          };
        }
        throw new BadRequestException({
          errorCode: 'INVENTORY_ALREADY_SOLD',
          message: `Inventory item ${inventoryId} is already sold to order ${item.orderId}`,
        });
      }

      if (item.status === InventoryStatus.DEFECTIVE) {
        throw new BadRequestException({
          errorCode: 'INVENTORY_ITEM_DEFECTIVE',
          message: `Inventory item ${inventoryId} is marked as DEFECTIVE and cannot be sold`,
        });
      }

      if (
        item.status === InventoryStatus.RESERVED &&
        item.orderId &&
        item.orderId !== orderId
      ) {
        throw new BadRequestException({
          errorCode: 'INVENTORY_ORDER_MISMATCH',
          message: `Inventory item ${inventoryId} is reserved for order ${item.orderId}, cannot confirm for order ${orderId}`,
        });
      }

      if (
        item.status !== InventoryStatus.RESERVED &&
        item.status !== InventoryStatus.AVAILABLE
      ) {
        throw new BadRequestException({
          errorCode: 'INVENTORY_ITEM_INVALID_STATUS',
          message: `Inventory item ${inventoryId} is in status ${item.status}, expected RESERVED or AVAILABLE`,
        });
      }

      const [updated] = await runner
        .update(productInventory)
        .set({
          status: InventoryStatus.SOLD,
          orderId,
          soldAt: sql`now()`,
        })
        .where(
          and(
            eq(productInventory.id, inventoryId),
            inArray(productInventory.status, [
              InventoryStatus.AVAILABLE,
              InventoryStatus.RESERVED,
            ]),
          ),
        )
        .returning();

      if (!updated) {
        throw new BadRequestException({
          errorCode: 'INVENTORY_ITEM_INVALID_STATUS',
          message: `Inventory item ${inventoryId} could not be sold — status changed concurrently`,
        });
      }

      const plaintext = decryptCredential(updated.credentialData);

      let soldAtIso: string;
      if (updated.soldAt instanceof Date && !isNaN(updated.soldAt.getTime())) {
        soldAtIso = updated.soldAt.toISOString();
      } else if (typeof updated.soldAt === 'string' && !isNaN(new Date(updated.soldAt).getTime())) {
        soldAtIso = new Date(updated.soldAt).toISOString();
      } else {
        soldAtIso = new Date().toISOString();
      }

      return {
        id: updated.id,
        productId: updated.productId,
        credentialData: plaintext,
        orderId: updated.orderId ?? orderId,
        soldAt: soldAtIso,
      };
    }, tx);
  }

  /**
   * Marks an inventory item as DEFECTIVE.
   */
  async markDefective(
    inventoryId: string,
    reason?: string,
    tx: DbOrTx = db,
  ): Promise<boolean> {
    const [updated] = await tx
      .update(productInventory)
      .set({
        status: InventoryStatus.DEFECTIVE,
      })
      .where(
        and(
          eq(productInventory.id, inventoryId),
          inArray(productInventory.status, [
            InventoryStatus.AVAILABLE,
            InventoryStatus.RESERVED,
          ]),
        ),
      )
      .returning({ id: productInventory.id });

    return Boolean(updated);
  }

  /**
   * Ingests a batch of digital credentials for a given product.
   * Sanitizes items and encrypts each credential using AES-256-GCM before saving.
   */
  async addCredentials(
    productId: string,
    credentials: string[],
    tx: DbOrTx = db,
  ): Promise<number> {
    const validCredentials = credentials
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter((c) => c.length > 0);

    if (validCredentials.length === 0) {
      return 0;
    }

    if (validCredentials.length > 500) {
      throw new BadRequestException({
        errorCode: 'BATCH_SIZE_EXCEEDED',
        message: 'Cannot ingest more than 500 credentials in a single batch',
      });
    }

    return this.ensureTransaction(async (runner) => {
      const [product] = await runner
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);

      if (!product) {
        throw new NotFoundException({
          errorCode: 'PRODUCT_NOT_FOUND',
          message: `Product ${productId} not found`,
        });
      }

      const records = validCredentials.map((cred) => ({
        productId,
        credentialData: encryptCredential(cred),
        status: InventoryStatus.AVAILABLE,
      }));

      const inserted = await runner
        .insert(productInventory)
        .values(records)
        .returning({ id: productInventory.id });

      return inserted.length;
    }, tx);
  }

  /**
   * Returns aggregated stock metrics broken down by inventory status.
   */
  async getStockSummary(productId: string, tx: DbOrTx = db): Promise<InventorySummaryDto> {
    const counts = await tx
      .select({
        status: productInventory.status,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .where(eq(productInventory.productId, productId))
      .groupBy(productInventory.status);

    let available = 0;
    let reserved = 0;
    let sold = 0;
    let defective = 0;

    for (const row of counts) {
      const num = Number(row.count);
      switch (row.status) {
        case InventoryStatus.AVAILABLE:
          available = num;
          break;
        case InventoryStatus.RESERVED:
          reserved = num;
          break;
        case InventoryStatus.SOLD:
          sold = num;
          break;
        case InventoryStatus.DEFECTIVE:
          defective = num;
          break;
      }
    }

    return {
      available,
      reserved,
      sold,
      defective,
      total: available + reserved + sold + defective,
    };
  }

  // ---------------------------------------------------------------------------
  // Story 5.2: Admin Inventory Management Methods
  // ---------------------------------------------------------------------------

  /**
   * Lists inventory items for a product with pagination and optional status filter.
   * Credentials are masked by default for security.
   */
  async listProductInventory(
    productId: string,
    query: ListInventoryQueryDto,
    tx: DbOrTx = db,
  ): Promise<{ items: AdminInventoryItemDto[]; total: number }> {
    const limit = Math.min(query.limit ?? 50, 100);
    const offset = query.offset ?? 0;
    const statusFilter = query.status;

    let whereClause = eq(productInventory.productId, productId);
    if (statusFilter) {
      whereClause = and(whereClause, eq(productInventory.status, statusFilter))!;
    }

    const [items, countResult] = await Promise.all([
      tx
        .select({
          id: productInventory.id,
          productId: productInventory.productId,
          status: productInventory.status,
          orderId: productInventory.orderId,
          credentialData: productInventory.credentialData,
          addedAt: productInventory.addedAt,
          soldAt: productInventory.soldAt,
        })
        .from(productInventory)
        .where(whereClause)
        .orderBy(productInventory.addedAt)
        .limit(limit)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(productInventory)
        .where(whereClause),
    ]);

    const maskedItems: AdminInventoryItemDto[] = items.map((item) => {
      let maskedCredential = '***';
      try {
        const plaintext = decryptCredential(item.credentialData);
        maskedCredential = maskCredential(plaintext);
      } catch {
        maskedCredential = '***';
      }
      return {
        id: item.id,
        productId: item.productId,
        status: item.status as InventoryStatus,
        orderId: item.orderId,
        addedAt: item.addedAt?.toISOString() ?? new Date().toISOString(),
        soldAt: item.soldAt?.toISOString() ?? null,
        maskedCredential,
      };
    });

    return {
      items: maskedItems,
      total: Number(countResult[0]?.count ?? 0),
    };
  }

  /**
   * Returns global inventory summary across all products.
   */
  async getGlobalInventorySummary(tx: DbOrTx = db): Promise<AdminGlobalInventorySummaryDto> {
    const statusCounts = await tx
      .select({
        status: productInventory.status,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .groupBy(productInventory.status);

    let totalAvailable = 0;
    let totalReserved = 0;
    let totalSold = 0;
    let totalDefective = 0;

    for (const row of statusCounts) {
      const num = Number(row.count);
      switch (row.status) {
        case InventoryStatus.AVAILABLE:
          totalAvailable = num;
          break;
        case InventoryStatus.RESERVED:
          totalReserved = num;
          break;
        case InventoryStatus.SOLD:
          totalSold = num;
          break;
        case InventoryStatus.DEFECTIVE:
          totalDefective = num;
          break;
      }
    }

    const productCounts = await tx
      .select({
        productId: productInventory.productId,
        status: productInventory.status,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .groupBy(productInventory.productId, productInventory.status);

    const productMap = new Map<string, ProductStockSummaryDto>();
    for (const row of productCounts) {
      const pid = row.productId;
      if (!productMap.has(pid)) {
        const [product] = await tx
          .select({ title: products.title })
          .from(products)
          .where(eq(products.id, pid))
          .limit(1);
        productMap.set(pid, {
          productId: pid,
          productTitle: product?.title ?? 'Unknown',
          available: 0,
          reserved: 0,
          sold: 0,
          defective: 0,
          total: 0,
        });
      }
      const summary = productMap.get(pid)!;
      const num = Number(row.count);
      switch (row.status) {
        case InventoryStatus.AVAILABLE:
          summary.available = num;
          break;
        case InventoryStatus.RESERVED:
          summary.reserved = num;
          break;
        case InventoryStatus.SOLD:
          summary.sold = num;
          break;
        case InventoryStatus.DEFECTIVE:
          summary.defective = num;
          break;
      }
      summary.total = summary.available + summary.reserved + summary.sold + summary.defective;
    }

    return {
      totalAvailable,
      totalReserved,
      totalSold,
      totalDefective,
      productStockSummaries: Array.from(productMap.values()),
    };
  }

  /**
   * Batch imports credentials with validation and deduplication.
   */
  async batchImportCredentials(
    productId: string,
    lines: string[],
    tx: DbOrTx = db,
  ): Promise<{ count: number; addedAt: string }> {
    return this.ensureTransaction(async (runner) => {
      const [product] = await runner
        .select({
          id: products.id,
          isActive: products.isActive,
          sourcingMode: products.sourcingMode,
        })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);

      if (!product) {
        throw new NotFoundException({
          statusCode: 404,
          errorCode: 'PRODUCT_NOT_FOUND',
          message: `Product ${productId} not found`,
        });
      }

      if (!product.isActive) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'PRODUCT_IS_INACTIVE',
          message: 'Cannot import credentials for inactive product',
        });
      }

      if (product.sourcingMode === 'EXTERNAL') {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'PRODUCT_DOES_NOT_ACCEPT_INVENTORY',
          message: 'EXTERNAL products do not accept in-house inventory',
        });
      }

      const normalized = lines
        .map((line) => (typeof line === 'string' ? line.replace(/\r\n/g, '\n') : ''))
        .flatMap((line) => line.split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

      if (normalized.length === 0) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'EMPTY_BATCH_PAYLOAD',
          message: 'No valid credential lines found in batch',
        });
      }

      for (const line of normalized) {
        if (line.length > 2048) {
          throw new BadRequestException({
            statusCode: 400,
            errorCode: 'LINE_TOO_LONG',
            message: `Credential line exceeds 2048 characters: ${line.slice(0, 50)}...`,
          });
        }
      }

      if (normalized.length > 500) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'BATCH_SIZE_EXCEEDED',
          message: 'Cannot import more than 500 credentials in a single batch',
        });
      }

      const uniqueCredentials = [...new Set(normalized)];

      const records = uniqueCredentials.map((cred) => ({
        productId,
        credentialData: encryptCredential(cred),
        status: InventoryStatus.AVAILABLE,
      }));

      const inserted = await runner
        .insert(productInventory)
        .values(records)
        .returning({ id: productInventory.id });

      return {
        count: inserted.length,
        addedAt: new Date().toISOString(),
      };
    }, tx);
  }

  /**
   * Deletes a credential only if status is AVAILABLE or DEFECTIVE.
   * Prevents deletion of RESERVED or SOLD credentials to preserve order history.
   */
  async deleteCredential(id: string, tx: DbOrTx = db): Promise<boolean> {
    const result = await tx
      .delete(productInventory)
      .where(
        and(
          eq(productInventory.id, id),
          inArray(productInventory.status, [
            InventoryStatus.AVAILABLE,
            InventoryStatus.DEFECTIVE,
          ]),
        ),
      )
      .returning({ id: productInventory.id });

    if (result.length === 0) {
      const [item] = await tx
        .select({ status: productInventory.status })
        .from(productInventory)
        .where(eq(productInventory.id, id))
        .limit(1);

      if (item && (item.status === InventoryStatus.RESERVED || item.status === InventoryStatus.SOLD)) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'CANNOT_DELETE_ACTIVE_OR_SOLD_CREDENTIAL',
          message: `Cannot delete credential in status ${item.status}. Only AVAILABLE or DEFECTIVE credentials can be deleted.`,
        });
      }

      if (!item) {
        throw new NotFoundException({
          statusCode: 404,
          errorCode: 'INVENTORY_ITEM_NOT_FOUND',
          message: `Inventory item ${id} not found`,
        });
      }
    }

    return true;
  }

  /**
   * Updates credential status between AVAILABLE and DEFECTIVE.
   */
  async updateCredentialStatus(
    id: string,
    newStatus: 'AVAILABLE' | 'DEFECTIVE',
    tx: DbOrTx = db,
  ): Promise<boolean> {
    const [updated] = await tx
      .update(productInventory)
      .set({ status: newStatus })
      .where(
        and(
          eq(productInventory.id, id),
          inArray(productInventory.status, [
            InventoryStatus.AVAILABLE,
            InventoryStatus.DEFECTIVE,
          ]),
        ),
      )
      .returning({ id: productInventory.id, status: productInventory.status });

    if (!updated) {
      const [item] = await tx
        .select({ status: productInventory.status })
        .from(productInventory)
        .where(eq(productInventory.id, id))
        .limit(1);

      if (!item) {
        throw new NotFoundException({
          statusCode: 404,
          errorCode: 'INVENTORY_ITEM_NOT_FOUND',
          message: `Inventory item ${id} not found`,
        });
      }

      throw new ConflictException({
        statusCode: 409,
        errorCode: 'CANNOT_UPDATE_STATUS_OF_RESERVED_OR_SOLD',
        message: `Cannot update status of credential in status ${item.status}`,
      });
    }

    return true;
  }

  /**
   * Decrypts a single credential for admin inspection with audit logging.
   */
  async decryptSingleCredential(
    id: string,
    adminId: string,
    ipAddress: string,
    tx: DbOrTx = db,
  ): Promise<string> {
    const [item] = await tx
      .select({
        id: productInventory.id,
        credentialData: productInventory.credentialData,
      })
      .from(productInventory)
      .where(eq(productInventory.id, id))
      .limit(1);

    if (!item) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'INVENTORY_ITEM_NOT_FOUND',
        message: `Inventory item ${id} not found`,
      });
    }

    console.log(
      `[AUDIT] Admin ${adminId} decrypted credential ${id} from IP ${ipAddress} at ${new Date().toISOString()}`,
    );

    return decryptCredential(item.credentialData);
  }
}
