import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { SourcingQueueService } from './sourcing-queue.service';

@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService, SourcingQueueService],
  exports: [SuppliersService, SourcingQueueService],
})
export class SuppliersModule {}
