import { Module } from '@nestjs/common';
import { ScraperModule } from './modules/suppliers/scraper/scraper.module';
import { SourcingWorker } from './workers/sourcing.worker';

@Module({
  imports: [ScraperModule],
  providers: [SourcingWorker],
})
export class WorkerModule {}
