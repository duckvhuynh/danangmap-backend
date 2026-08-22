import { Injectable } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';
import type { GeometryKind, GeometryMode } from '../domain/enums';
import type {
  LayerFieldDto,
  LayerPopupConfigDto,
  LayerRenderConfigDto,
  LayerStyleDto,
} from './layer.dto';

@Injectable()
export class LayerSchemaService {
  validateLayer(
    geometryMode: GeometryMode,
    kinds: GeometryKind[],
    fields: LayerFieldDto[],
    popupConfig: LayerPopupConfigDto,
    style: LayerStyleDto = {},
    renderConfig: LayerRenderConfigDto = {},
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
      if (field.sensitive && field.public) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Field nhạy cảm ${field.key} không được công khai.`,
        );
      }
      this.validateFieldDefinition(field);
    }
    const fieldKeys = popupConfig.fieldKeys ?? [];
    for (const key of [popupConfig.titleField, popupConfig.subtitleField, ...fieldKeys]) {
      if (typeof key === 'string' && !keys.has(key)) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Popup tham chiếu field không tồn tại: ${key}`,
        );
      }
      if (
        typeof key === 'string' &&
        !fields.some((field) => field.key === key && field.public && !field.sensitive)
      ) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Popup chỉ được tham chiếu field công khai, không nhạy cảm: ${key}`,
        );
      }
    }
    this.validateStyleAndRender(kinds, style, renderConfig);
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
      this.assertConstraints(field, value);
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

  private validateFieldDefinition(field: LayerFieldDto): void {
    const validation = field.validation ?? {};
    if (
      validation.minLength !== undefined &&
      validation.maxLength !== undefined &&
      validation.minLength > validation.maxLength
    ) {
      throw new AppException(422, 'SCHEMA_VIOLATION', `minLength lớn hơn maxLength: ${field.key}`);
    }
    if (
      validation.minimum !== undefined &&
      validation.maximum !== undefined &&
      validation.minimum > validation.maximum
    ) {
      throw new AppException(422, 'SCHEMA_VIOLATION', `minimum lớn hơn maximum: ${field.key}`);
    }
    const stringType = [
      'text',
      'long_text',
      'date',
      'datetime',
      'url',
      'email',
      'phone',
      'address',
    ].includes(field.type);
    const numericType = field.type === 'number' || field.type === 'integer';
    if (!stringType && (validation.minLength !== undefined || validation.maxLength !== undefined)) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        `Giới hạn độ dài không tương thích field ${field.key}.`,
      );
    }
    if (!numericType && (validation.minimum !== undefined || validation.maximum !== undefined)) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        `Giới hạn số không tương thích field ${field.key}.`,
      );
    }
    const enumType = field.type === 'enum' || field.type === 'multi_enum';
    if (enumType && field.options.length === 0) {
      throw new AppException(422, 'SCHEMA_VIOLATION', `Field enum ${field.key} phải có options.`);
    }
    if (!enumType && field.options.length > 0) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        `options chỉ hợp lệ với field enum: ${field.key}`,
      );
    }
    if (field.defaultValue !== undefined && field.defaultValue !== null) {
      if (!this.matchesType(field.type, field.defaultValue)) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Default value sai kiểu dữ liệu: ${field.key}`,
        );
      }
      this.assertConstraints(field, field.defaultValue);
    }
  }

  private assertConstraints(field: LayerFieldDto, value: unknown): void {
    const validation = field.validation ?? {};
    if (typeof value === 'string') {
      if (validation.minLength !== undefined && value.length < validation.minLength) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị quá ngắn: ${field.key}`);
      }
      if (validation.maxLength !== undefined && value.length > validation.maxLength) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị quá dài: ${field.key}`);
      }
    }
    if (typeof value === 'number') {
      if (validation.minimum !== undefined && value < validation.minimum) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị quá nhỏ: ${field.key}`);
      }
      if (validation.maximum !== undefined && value > validation.maximum) {
        throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị quá lớn: ${field.key}`);
      }
    }
    if (field.type === 'enum' && !field.options.includes(value as string)) {
      throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị ngoài options: ${field.key}`);
    }
    if (
      field.type === 'multi_enum' &&
      (!(value instanceof Array) || value.some((item) => !field.options.includes(item as string)))
    ) {
      throw new AppException(422, 'SCHEMA_VIOLATION', `Giá trị ngoài options: ${field.key}`);
    }
  }

  private validateStyleAndRender(
    kinds: GeometryKind[],
    style: LayerStyleDto,
    renderConfig: LayerRenderConfigDto,
  ): void {
    if (
      renderConfig.minZoom !== undefined &&
      renderConfig.maxZoom !== undefined &&
      renderConfig.minZoom > renderConfig.maxZoom
    ) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'minZoom không được lớn hơn maxZoom.');
    }
    const pointKinds = kinds.some((kind) => ['point', 'multipoint', 'circle'].includes(kind));
    const lineKinds = kinds.some((kind) => ['line', 'multiline'].includes(kind));
    const polygonKinds = kinds.some((kind) => ['polygon', 'multipolygon'].includes(kind));
    if (style.point && !pointKinds) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Point style không tương thích geometry.');
    }
    if (style.line && !lineKinds) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Line style không tương thích geometry.');
    }
    if (style.polygon && !polygonKinds) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Polygon style không tương thích geometry.');
    }
    if ((renderConfig.cluster || style.point?.cluster) && !pointKinds) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Cluster chỉ hợp lệ với point/circle.');
    }
  }
}
