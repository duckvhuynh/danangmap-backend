import { HttpException } from '@nestjs/common';

export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, status);
  }
}
