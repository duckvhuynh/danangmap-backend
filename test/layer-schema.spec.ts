import { AppException } from '../src/common/http/app.exception';
import { LayerFieldDto } from '../src/layers/layer.dto';
import { LayerSchemaService } from '../src/layers/layer-schema.service';

describe('LayerSchemaService', () => {
  const service = new LayerSchemaService();

  function field(overrides: Partial<LayerFieldDto> = {}): LayerFieldDto {
    return Object.assign(new LayerFieldDto(), {
      key: 'name',
      label: 'Tên',
      type: 'text',
      required: true,
      public: true,
      searchable: true,
      filterable: false,
      sortable: true,
      sensitive: false,
      offlineCache: true,
      validation: {},
      options: [],
      displayOrder: 10,
      ...overrides,
    });
  }

  it('accepts a mixed geometry allow-list and safe popup config', () => {
    expect(() =>
      service.validateLayer('mixed', ['point', 'multipolygon'], [field()], {
        titleField: 'name',
        fieldKeys: ['name'],
      }),
    ).not.toThrow();
  });

  it('rejects sensitive fields from the recovery cache', () => {
    expect(() =>
      service.validateLayer('point', ['point'], [field({ sensitive: true })], {}),
    ).toThrow(AppException);
  });

  it('rejects properties outside the declared schema', () => {
    expect(() => service.validateProperties([field()], { name: 'A', privateNote: 'leak' })).toThrow(
      AppException,
    );
  });
});
