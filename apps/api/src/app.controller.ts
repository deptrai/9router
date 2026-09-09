import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class AppController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: '9router-ecommerce-api',
      timestamp: new Date().toISOString(),
    };
  }
}
