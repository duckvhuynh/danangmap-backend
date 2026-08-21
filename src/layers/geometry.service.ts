import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import type { GeometryKind } from '../domain/enums';

interface GeometryInspection {
  type: string;
  valid: boolean;
  valid_reason: string;
  vertices: number;
  empty: boolean;
  dimensions: number;
}

const KIND_TO_TYPE: Record<Exclude<GeometryKind, 'circle'>, string> = {
  point: 'POINT',
  multipoint: 'MULTIPOINT',
  line: 'LINESTRING',
  multiline: 'MULTILINESTRING',
  polygon: 'POLYGON',
  multipolygon: 'MULTIPOLYGON',
};

@Injectable()
export class GeometryService {
  constructor(private readonly dataSource: DataSource) {}

  async validate(geometry: Record<string, unknown>, kind: GeometryKind, radiusM?: number | null) {
    this.rejectUnsupportedCoordinates(geometry);
    const serialized = JSON.stringify(geometry);
    if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) {
      throw new AppException(422, 'RESOURCE_LIMIT_EXCEEDED', 'Geometry vượt giới hạn payload.');
    }
    let rows: GeometryInspection[];
    try {
      rows = (await this.dataSource.query(
        `
          WITH candidate AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
          )
          SELECT
            GeometryType(geom) AS type,
            ST_IsValid(geom) AS valid,
            ST_IsValidReason(geom) AS valid_reason,
            ST_NPoints(geom)::integer AS vertices,
            ST_IsEmpty(geom) AS empty,
            ST_NDims(geom)::integer AS dimensions
          FROM candidate
        `,
        [serialized],
      )) as GeometryInspection[];
    } catch {
      throw new AppException(422, 'GEOMETRY_INVALID', 'GeoJSON geometry không hợp lệ.');
    }
    const inspection = rows[0];
    if (!inspection || inspection.empty || inspection.dimensions !== 2) {
      throw new AppException(
        422,
        'GEOMETRY_INVALID',
        'Geometry rỗng hoặc có tọa độ Z/M không được hỗ trợ.',
      );
    }
    const expected = kind === 'circle' ? 'POINT' : KIND_TO_TYPE[kind];
    if (inspection.type !== expected) {
      throw new AppException(
        422,
        'GEOMETRY_TYPE_NOT_ALLOWED',
        'Geometry không khớp loại đã khai báo.',
        {
          expected,
          actual: inspection.type,
        },
      );
    }
    if (!inspection.valid) {
      throw new AppException(422, 'GEOMETRY_INVALID', 'Geometry không hợp lệ.', {
        reason: inspection.valid_reason,
      });
    }
    if (inspection.vertices > 100_000) {
      throw new AppException(422, 'RESOURCE_LIMIT_EXCEEDED', 'Feature vượt quá 100.000 vertex.');
    }
    if (kind === 'circle' && (!radiusM || radiusM <= 0)) {
      throw new AppException(422, 'GEOMETRY_INVALID', 'Circle cần radiusM dương theo mét.');
    }
    if (kind !== 'circle' && radiusM != null) {
      throw new AppException(422, 'GEOMETRY_INVALID', 'radiusM chỉ hợp lệ cho circle.');
    }
    return inspection;
  }

  private rejectUnsupportedCoordinates(geometry: Record<string, unknown>): void {
    if (geometry.type === 'GeometryCollection') {
      throw new AppException(
        422,
        'GEOMETRY_TYPE_NOT_ALLOWED',
        'GeometryCollection không được hỗ trợ.',
      );
    }
    if (!('coordinates' in geometry)) {
      throw new AppException(422, 'GEOMETRY_INVALID', 'Geometry thiếu coordinates.');
    }
    const visit = (value: unknown): void => {
      if (!Array.isArray(value)) {
        throw new AppException(422, 'GEOMETRY_INVALID', 'Tọa độ GeoJSON không hợp lệ.');
      }
      if (value.every((item) => typeof item === 'number')) {
        if (value.length !== 2 || value.some((item) => !Number.isFinite(item))) {
          throw new AppException(422, 'GEOMETRY_INVALID', 'Chỉ hỗ trợ tọa độ 2D hữu hạn.');
        }
        const [longitude, latitude] = value as number[];
        if (longitude! < -180 || longitude! > 180 || latitude! < -90 || latitude! > 90) {
          throw new AppException(422, 'GEOMETRY_INVALID', 'Tọa độ nằm ngoài phạm vi EPSG:4326.');
        }
        return;
      }
      if (!value.length) throw new AppException(422, 'GEOMETRY_INVALID', 'Geometry rỗng.');
      value.forEach(visit);
    };
    visit(geometry.coordinates);
  }
}
