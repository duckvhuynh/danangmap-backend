import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import {
  ImportParserError,
  parseImportRecords,
  parseWktGeometry,
} from '../src/imports/import-record.parser';

describe('Import record parsers', () => {
  it('round-trips Vietnamese Windows-1258 CSV text and stable delimiter tokens', async () => {
    const content = encodeWindows1258(
      'name;longitude;latitude\r\nĐà Nẵng;108.2022;16.0544\r\nPhường Hải Châu;108.22;16.06',
    );
    await expect(
      parseImportRecords(content, 'csv', { encoding: 'windows1258', delimiter: 'semicolon' }, 100),
    ).resolves.toEqual([
      { name: 'Đà Nẵng', longitude: '108.2022', latitude: '16.0544' },
      { name: 'Phường Hải Châu', longitude: '108.22', latitude: '16.06' },
    ]);
  });

  it('selects exactly one XLSX sheet and reads only cached formula results', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Ignored').addRow(['bad']);
    const selected = workbook.addWorksheet('DanhSach');
    selected.addRow(['name', 'longitude', 'latitude']);
    selected.addRow([
      { formula: 'HYPERLINK("https://invalid.example")', result: 'Đà Nẵng' },
      108.2,
      16.05,
    ]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseImportRecords(content, 'xlsx', { sheet: 'DanhSach' }, 100)).resolves.toEqual([
      { name: 'Đà Nẵng', longitude: 108.2, latitude: 16.05 },
    ]);
    await expect(
      parseImportRecords(content, 'xlsx', { sheet: 'Missing' }, 100),
    ).rejects.toMatchObject({ code: 'XLSX_SHEET_NOT_FOUND' });
  });

  it('normalizes canonically equivalent Unicode headers in XLSX files', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dữ liệu');
    sheet.addRow(['Tên'.normalize('NFD'), 'Vĩ độ'.normalize('NFD')]);
    sheet.addRow(['Sở Công Thương', 16.017949]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseImportRecords(content, 'xlsx', { sheet: 'Dữ liệu' }, 100)).resolves.toEqual([
      { Tên: 'Sở Công Thương', 'Vĩ độ': 16.017949 },
    ]);
  });

  it('normalizes safe KML Placemarks and blocks entity/network payloads', async () => {
    const safe = Buffer.from(`<?xml version="1.0"?>
      <kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>Đà Nẵng</name><ExtendedData>
          <Data name="external_id"><value>dn-1</value></Data>
        </ExtendedData><Point><coordinates>108.2022,16.0544</coordinates></Point></Placemark>
      </Document></kml>`);
    await expect(parseImportRecords(safe, 'kml', {}, 100)).resolves.toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [108.2022, 16.0544] },
        properties: { name: 'Đà Nẵng', external_id: 'dn-1' },
      },
    ]);
    const unsafe = [
      '<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>',
      '<kml><NetworkLink><Link><href>https://invalid.example/a.kml</href></Link></NetworkLink></kml>',
    ];
    for (const xml of unsafe) {
      await expect(parseImportRecords(Buffer.from(xml), 'kml', {}, 100)).rejects.toMatchObject({
        code: 'KML_UNSAFE_XML',
      });
    }
  });

  it('rejects prototype-polluting headers and invalid multi-coordinate KML Points', async () => {
    await expect(
      parseImportRecords(Buffer.from('__proto__,longitude,latitude\nx,108,16'), 'csv', {}, 100),
    ).rejects.toMatchObject({ code: 'CSV_INVALID' });
    await expect(
      parseImportRecords(
        Buffer.from(
          '<kml><Placemark><Point><coordinates>108,16 109,17</coordinates></Point></Placemark></kml>',
        ),
        'kml',
        {},
        100,
      ),
    ).rejects.toMatchObject({ code: 'KML_INVALID' });
  });

  it('parses WKT without accepting arbitrary values', () => {
    expect(parseWktGeometry('POINT (108.2 16.05)')).toEqual({
      type: 'Point',
      coordinates: [108.2, 16.05],
    });
    expect(() => parseWktGeometry('NOT_A_GEOMETRY')).toThrow(ImportParserError);
    expect(() => parseWktGeometry('SRID=3857;POINT (108.2 16.05)')).toThrow(ImportParserError);
  });
});

function encodeWindows1258(value: string): Buffer {
  const toneMarks = new Set(['\u0300', '\u0301', '\u0303', '\u0309', '\u0323']);
  const representable = [...value]
    .map((character) => {
      const decomposed = [...character.normalize('NFD')];
      const base = decomposed
        .filter((part) => !toneMarks.has(part))
        .join('')
        .normalize('NFC');
      const tone = decomposed.filter((part) => toneMarks.has(part)).join('');
      return `${base}${tone}`;
    })
    .join('');
  return iconv.encode(representable, 'windows1258');
}
