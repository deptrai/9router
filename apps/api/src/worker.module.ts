import { Module } from '@nestjs/common';
import { ScraperModule } from './modules/suppliers/scraper/scraper.module';
import { SourcingWorker } from './workers/sourcing.worker';
import { CatalogSyncWorker } from './workers/catalog-sync.worker';

@Module({
  imports: [ScraperModule],
  providers: [SourcingWorker, CatalogSyncWorker],
})
export class WorkerModule {}
