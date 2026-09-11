import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
} from '@repo/shared-types';

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
}
