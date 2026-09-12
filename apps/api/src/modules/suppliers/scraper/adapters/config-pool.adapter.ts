import { Injectable } from '@nestjs/common';
import { DbTransaction, eq, supplierSources } from '@repo/database';
import {
  ISupplierAdapter,
  ProductRecord,
  PurchaseResult,
  SupplierSourceRecord,
  SupplierTerminalError,
} from './supplier-adapter';

@Injectable()
export class ConfigPoolAdapter implements ISupplierAdapter {
  async purchase(
    _product: ProductRecord,
    supplier: SupplierSourceRecord,
  ): Promise<PurchaseResult> {
    const creds = (supplier.configCredentials as Record<string, any>) ?? {};
    const pool = creds.credentialPool;
    if (
      !Array.isArray(pool) ||
      pool.length === 0 ||
      typeof pool[0] !== 'string' ||
      !pool[0].trim()
    ) {
      throw new SupplierTerminalError('CREDENTIAL_POOL_EMPTY');
    }
    return {
      credential: pool[0].trim(),
      externalOrderId: 'config-pool',
    };
  }

  async commit(
    supplierId: string,
    _hint: PurchaseResult,
    tx: DbTransaction,
  ): Promise<PurchaseResult> {
    const [row] = await tx
      .select()
      .from(supplierSources)
      .where(eq(supplierSources.id, supplierId))
      .for('update');

    const creds = (row?.configCredentials as Record<string, any>) ?? {};
    const pool: string[] = Array.isArray(creds.credentialPool)
      ? [...creds.credentialPool]
      : [];

    if (
      pool.length === 0 ||
      typeof pool[0] !== 'string' ||
      !pool[0].trim()
    ) {
      throw new SupplierTerminalError('CREDENTIAL_POOL_EMPTY');
    }

    const [credential, ...rest] = pool;
    await tx
      .update(supplierSources)
      .set({
        configCredentials: { ...creds, credentialPool: rest },
        updatedAt: new Date(),
      })
      .where(eq(supplierSources.id, supplierId));

    return {
      credential: credential.trim(),
      externalOrderId: 'config-pool',
    };
  }
}
