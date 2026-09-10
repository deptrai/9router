import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { VietQRService } from './vietqr.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [UsersModule],
  providers: [VietQRService, PaymentsService],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
