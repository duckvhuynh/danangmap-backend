import type { ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { MAX_IMPORT_BYTES } from '../src/imports/import-file.inspector';
import { ImportUploadGuard } from '../src/imports/import-upload.guard';

describe('ImportUploadGuard', () => {
  const context = (contentLength: string | undefined, response: EventEmitter) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ header: () => contentLength }),
        getResponse: () => response,
      }),
    }) as unknown as ExecutionContext;

  it('requires Content-Length before allocating a Multer buffer', () => {
    const response = new EventEmitter();
    expect(() => new ImportUploadGuard().canActivate(context(undefined, response))).toThrow(
      expect.objectContaining({ code: 'CONTENT_LENGTH_REQUIRED' }),
    );
  });

  it('rejects a request larger than the file limit plus multipart overhead', () => {
    const response = new EventEmitter();
    expect(() =>
      new ImportUploadGuard().canActivate(
        context(String(MAX_IMPORT_BYTES + 1024 * 1024 + 1), response),
      ),
    ).toThrow(expect.objectContaining({ code: 'IMPORT_FILE_TOO_LARGE' }));
  });

  it('caps in-memory uploads at two concurrent requests and releases the slot', () => {
    const responses: [EventEmitter, EventEmitter, EventEmitter] = [
      new EventEmitter(),
      new EventEmitter(),
      new EventEmitter(),
    ];
    const guard = new ImportUploadGuard();
    expect(guard.canActivate(context('1024', responses[0]))).toBe(true);
    expect(guard.canActivate(context('1024', responses[1]))).toBe(true);
    expect(() => guard.canActivate(context('1024', responses[2]))).toThrow(
      expect.objectContaining({ code: 'IMPORT_UPLOAD_BUSY' }),
    );

    responses[0].emit('finish');
    expect(guard.canActivate(context('1024', responses[2]))).toBe(true);
    responses[1].emit('close');
    responses[2].emit('finish');
  });
});
