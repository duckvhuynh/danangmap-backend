import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppException } from '../common/http/app.exception';
import type { RequestWithContext } from '../common/http/request-context';

export const MAX_USER_IMPORT_BYTES = 5 * 1024 * 1024;

@Injectable()
export class UserImportUploadGuard implements CanActivate {
  private static activeUploads = 0;
  private static readonly maxConcurrentUploads = 2;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const response = context.switchToHttp().getResponse<Response>();
    const contentLength = Number(request.header('content-length'));
    if (!Number.isFinite(contentLength) || contentLength < 1) {
      throw new AppException(411, 'CONTENT_LENGTH_REQUIRED', 'Upload yêu cầu Content-Length.');
    }
    if (contentLength > MAX_USER_IMPORT_BYTES + 256 * 1024) {
      throw new AppException(
        413,
        'USER_IMPORT_FILE_TOO_LARGE',
        'Tệp import tài khoản tối đa 5 MiB.',
      );
    }
    if (UserImportUploadGuard.activeUploads >= UserImportUploadGuard.maxConcurrentUploads) {
      throw new AppException(
        429,
        'USER_IMPORT_UPLOAD_BUSY',
        'Máy chủ đang xử lý quá nhiều upload.',
      );
    }
    UserImportUploadGuard.activeUploads += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      UserImportUploadGuard.activeUploads = Math.max(0, UserImportUploadGuard.activeUploads - 1);
    };
    response.once('finish', release);
    response.once('close', release);
    return true;
  }
}
