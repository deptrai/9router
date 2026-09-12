import { Module } from '@nestjs/common';
import { SourcingQueueService } from './sourcing-queue.service';

@Module({
  providers: [SourcingQueueService],
  exports: [SourcingQueueService],
})
export class SuppliersModule {}
