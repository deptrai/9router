import { Injectable } from '@nestjs/common';
import { ISupplierAdapter } from './supplier-adapter';
import { ConfigPoolAdapter } from './config-pool.adapter';

@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<string, ISupplierAdapter>();

  constructor(private readonly configPoolAdapter: ConfigPoolAdapter) {
    this.register('CONFIG_POOL', this.configPoolAdapter);
  }

  register(type: string, adapter: ISupplierAdapter): void {
    this.adapters.set(type, adapter);
  }

  get(type: string): ISupplierAdapter | undefined {
    return this.adapters.get(type);
  }
}
