import { Injectable } from '@nestjs/common';
import { extname } from 'node:path';
import { AppException } from '../common/http/app.exception';
import type { ImportFormat } from '../domain/enums';

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

@Injectable()
export class ImportFileInspector {
  inspect(file: Pick<Express.Multer.File, 'buffer' | 'originalname' | 'size'>, requested?: string) {
    if (file.size < 1 || file.size > MAX_IMPORT_BYTES || file.buffer.byteLength !== file.size) {
      throw new AppException(413, 'IMPORT_FILE_TOO_LARGE', 'Tệp import tối đa 25 MiB.');
    }
    const detected = this.detect(file.originalname, file.buffer);
    if (requested && !this.isFormat(requested)) {
      throw new AppException(400, 'IMPORT_FORMAT_INVALID', 'Định dạng import không hợp lệ.');
    }
    if (requested && requested !== detected) {
      throw new AppException(
        422,
        'IMPORT_FORMAT_MISMATCH',
        'Nội dung tệp không khớp định dạng đã chọn.',
      );
    }
    return detected;
  }

  private detect(fileName: string, buffer: Buffer): ImportFormat {
    const extension = extname(fileName).toLowerCase();
    const prefix = buffer.subarray(0, Math.min(buffer.byteLength, 65_536));
    if (extension === '.xlsx' && prefix[0] === 0x50 && prefix[1] === 0x4b) return 'xlsx';

    const text = prefix
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart();
    if ((extension === '.kml' || extension === '.xml') && /<(?:\w+:)?kml[\s>]/i.test(text)) {
      return 'kml';
    }
    if (extension === '.geojson' || extension === '.json') {
      if (
        !/"type"\s*:\s*"(?:FeatureCollection|Feature|GeometryCollection|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon)"/.test(
          text,
        )
      ) {
        throw new AppException(422, 'GEOJSON_INVALID', 'Tệp JSON không phải GeoJSON hợp lệ.');
      }
      return 'geojson';
    }
    if (extension === '.csv' && !prefix.includes(0)) return 'csv';
    throw new AppException(
      415,
      'IMPORT_FORMAT_UNSUPPORTED',
      'Chỉ hỗ trợ CSV, XLSX, GeoJSON và KML.',
    );
  }

  private isFormat(value: string): value is ImportFormat {
    return ['csv', 'xlsx', 'geojson', 'kml'].includes(value);
  }
}
