import { Module } from '@nestjs/common';
import { OpsService } from './ops.service';
import { AdminOpsController } from './admin-ops.controller';
import { SuppliersModule } from '../suppliers/suppliers.module';

@Module({
  imports: [SuppliersModule],
  controllers: [AdminOpsController],
  providers: [OpsService],
})
export class OpsModule {}
