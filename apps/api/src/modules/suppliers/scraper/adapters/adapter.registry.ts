import { Injectable } from '@nestjs/common';
import { ISupplierAdapter } from './supplier-adapter';
import { ConfigPoolAdapter } from './config-pool.adapter';
import { TelegramBotAdapter } from './telegram-bot.adapter';

@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<string, ISupplierAdapter>();

  constructor(
    private readonly configPoolAdapter: ConfigPoolAdapter,
    private readonly telegramBotAdapter: TelegramBotAdapter
  ) {
    this.register('CONFIG_POOL', this.configPoolAdapter);
    this.register('TELEGRAM_BOT', this.telegramBotAdapter);
  }

  register(type: string, adapter: ISupplierAdapter): void {
    this.adapters.set(type, adapter);
  }

  get(type: string): ISupplierAdapter | undefined {
    return this.adapters.get(type);
  }
}
