import { HttpException, HttpStatus } from '@nestjs/common';

export class InsufficientFundsException extends HttpException {
  constructor(message = 'Insufficient wallet balance') {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: 'INSUFFICIENT_FUNDS',
        message,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}
