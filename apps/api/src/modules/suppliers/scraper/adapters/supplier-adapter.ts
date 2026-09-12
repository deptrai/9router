import { DbTransaction, products, supplierSources } from '@repo/database';

export interface PurchaseResult {
  credential: string;          // plaintext credential
  externalOrderId?: string;    // id bên thứ 3 (nếu có)
  cost?: string;               // chi phí thực tế (numeric string)
  rawPayload?: unknown;        // response raw để audit
}

export type ProductRecord = typeof products.$inferSelect;
export type SupplierSourceRecord = typeof supplierSources.$inferSelect;

export interface ISupplierAdapter {
  purchase(product: ProductRecord, supplier: SupplierSourceRecord): Promise<PurchaseResult>;
  /**
   * D-B — 2-phase commit trong tx: re-read config + shift pool + trả credential authoritative.
   * Adapter stateless khác có thể no-op trả `hint.credential`.
   */
  commit?(supplierId: string, hint: PurchaseResult, tx: DbTransaction): Promise<PurchaseResult>;
}

/** Lỗi không retry — executor map sang refund + UnrecoverableError. */
export class SupplierTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierTerminalError';
  }
}

/** Lỗi retryable — executor rethrow để BullMQ retry theo backoff. */
export class SupplierRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierRetryableError';
  }
}
