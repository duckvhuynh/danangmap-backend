import { ImportFileInspector, MAX_IMPORT_BYTES } from '../src/imports/import-file.inspector';

describe('ImportFileInspector', () => {
  const inspector = new ImportFileInspector();

  it('accepts a CSV at the exact 25 MiB boundary', () => {
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES, 0x61);
    expect(inspector.inspect({ buffer, size: buffer.byteLength, originalname: 'data.csv' })).toBe(
      'csv',
    );
  });

  it('rejects one byte over 25 MiB', () => {
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x61);
    expect(() =>
      inspector.inspect({ buffer, size: buffer.byteLength, originalname: 'data.csv' }),
    ).toThrow(expect.objectContaining({ code: 'IMPORT_FILE_TOO_LARGE' }));
  });

  it('requires .json payloads to be valid GeoJSON', () => {
    const buffer = Buffer.from('{"hello":"world"}');
    expect(() =>
      inspector.inspect({ buffer, size: buffer.byteLength, originalname: 'data.json' }),
    ).toThrow(expect.objectContaining({ code: 'GEOJSON_INVALID' }));
  });

  it('rejects a requested format that conflicts with sniffed content', () => {
    const buffer = Buffer.from('name,longitude,latitude\nA,108.2,16.1');
    expect(() =>
      inspector.inspect({ buffer, size: buffer.byteLength, originalname: 'data.csv' }, 'geojson'),
    ).toThrow(expect.objectContaining({ code: 'IMPORT_FORMAT_MISMATCH' }));
  });
});
