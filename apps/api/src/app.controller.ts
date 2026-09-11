import { Controller, Get } from '@nestjs/common';
import { RedisService } from './common/redis/redis.service';

@Controller('health')
export class AppController {
  constructor(private readonly redisService?: RedisService) {}

  @Get()
  async getHealth() {
    const redisHealthy = this.redisService ? await this.redisService.isHealthy() : null;
    return {
      status: 'ok',
      service: '9router-ecommerce-api',
      redis: redisHealthy,
      timestamp: new Date().toISOString(),
    };
  }
}
