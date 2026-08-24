import { ConfigService } from '@nestjs/config';
import { AppException } from '../src/common/http/app.exception';
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachmentBytes,
  validateDeclaredAttachment,
} from '../src/attachments/attachment-file.policy';
import { AttachmentScannerService } from '../src/attachments/attachment-scanner.service';

describe('Attachment security policy', () => {
  it('accepts matching raster magic and rejects MIME spoofing', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    expect(() => validateAttachmentBytes(png, 'image/png')).not.toThrow();
    expect(() => validateAttachmentBytes(Buffer.from('%PDF-1.7'), 'image/png')).toThrow(
      AppException,
    );
  });

  it('normalizes the declared file and enforces the exact 25 MiB boundary', () => {
    expect(
      validateDeclaredAttachment({
        fileName: '../Báo cáo.pdf',
        contentType: 'Application/PDF',
        sizeBytes: MAX_ATTACHMENT_BYTES,
      }),
    ).toEqual({ fileName: 'Báo cáo.pdf', contentType: 'application/pdf' });
    expect(() =>
      validateDeclaredAttachment({
        fileName: 'too-large.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow(AppException);
  });

  it('provides deterministic clean, infected, rejected and scanner-failure fixtures', async () => {
    const scanner = new AttachmentScannerService(
      new ConfigService({ attachments: { scannerMode: 'deterministic' } }),
    );
    await expect(scanner.scan(Buffer.from('ordinary content'))).resolves.toEqual({
      status: 'clean',
    });
    await expect(
      scanner.scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE')),
    ).resolves.toMatchObject({ status: 'infected' });
    await expect(scanner.scan(Buffer.from('DANANGMAP_SCAN_REJECT'))).resolves.toEqual({
      status: 'rejected',
      code: 'ATTACHMENT_SCAN_REJECTED',
    });
    await expect(scanner.scan(Buffer.from('DANANGMAP_SCAN_ERROR'))).rejects.toThrow(
      'ATTACHMENT_SCANNER_UNAVAILABLE',
    );
  });
});
