import { Injectable } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';
import type { GeometryKind, GeometryMode } from '../domain/enums';
import type { LayerFieldDto } from './layer.dto';

@Injectable()
export class LayerSchemaService {
  validateLayer(
    geometryMode: GeometryMode,
    kinds: GeometryKind[],
    fields: LayerFieldDto[],
    popupConfig: Record<string, unknown>,
  ): void {
    const uniqueKinds = new Set(kinds);
    if (uniqueKinds.size !== kinds.length) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Geometry allow-list có giá trị trùng.');
    }
    const allowedByMode: Record<Exclude<GeometryMode, 'mixed'>, GeometryKind[]> = {
      point: ['point', 'multipoint'],
      circle: ['circle'],
      polyline: ['line', 'multiline'],
      polygon: ['polygon', 'multipolygon'],
    };
    if (geometryMode !== 'mixed') {
      const allowed = allowedByMode[geometryMode];
      if (kinds.some((kind) => !allowed.includes(kind))) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          'Geometry allow-list không khớp layer type.',
        );
      }
    }
    const keys = new Set<string>();
    for (const field of fields) {
      if (keys.has(field.key)) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Field key ${field.key} bị trùng.`);
      }
      keys.add(field.key);
      if (field.sensitive && field.offlineCache) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Field nhạy cảm ${field.key} không được lưu offline.`,
        );
      }
    }
    const popupKeys = ['titleField', 'subtitleField', 'fieldKeys', 'showCoordinates'];
    if (Object.keys(popupConfig).some((key) => !popupKeys.includes(key))) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Popup config chứa key không được hỗ trợ.');
    }
    const fieldKeys: unknown[] = Array.isArray(popupConfig.fieldKeys)
      ? (popupConfig.fieldKeys as unknown[])
      : [];
    for (const key of [popupConfig.titleField, popupConfig.subtitleField, ...fieldKeys]) {
      if (typeof key === 'string' && !keys.has(key)) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Popup tham chiếu field không tồn tại: ${key}`,
        );
      }
    }
  }

  validateProperties(fields: LayerFieldDto[], properties: Record<string, unknown>): void {
    const byKey = new Map(fields.map((field) => [field.key, field]));
    for (const key of Object.keys(properties)) {
      if (!byKey.has(key)) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Property không thuộc schema: ${key}`);
      }
    }
    for (const field of fields) {
      const value = properties[field.key];
      if (field.required && (value == null || value === '')) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Thiếu field bắt buộc: ${field.key}`);
      }
      if (value == null) continue;
      if (!this.matchesType(field.type, value)) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Sai kiểu dữ liệu: ${field.key}`);
      }
    }
    if (Buffer.byteLength(JSON.stringify(properties), 'utf8') > 64 * 1024) {
      throw new AppException(422, 'RESOURCE_LIMIT_EXCEEDED', 'Properties vượt quá 64 KiB.');
    }
  }

  private matchesType(type: string, value: unknown): boolean {
    if (
      ['text', 'long_text', 'date', 'datetime', 'url', 'email', 'phone', 'address'].includes(type)
    ) {
      return typeof value === 'string';
    }
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'enum') return typeof value === 'string';
    if (type === 'multi_enum' || type === 'image' || type === 'attachment')
      return Array.isArray(value);
    return false;
  }
}
