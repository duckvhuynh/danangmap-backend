import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import { Geometry as WkxGeometry } from 'wkx';
import type { ImportFormat } from '../domain/enums';
import { normalizeImportColumnName } from './import-normalization';

export const MAX_XLSX_SHEETS = 10;
export const MAX_IMPORT_COLUMNS = 256;

export type ImportParserFailureCode =
  | 'CSV_INVALID'
  | 'XLSX_INVALID'
  | 'XLSX_SHEET_LIMIT'
  | 'XLSX_SHEET_NOT_FOUND'
  | 'IMPORT_COLUMN_LIMIT'
  | 'KML_INVALID'
  | 'KML_UNSAFE_XML'
  | 'KML_STRUCTURE_LIMIT'
  | 'WKT_INVALID'
  | 'GEOJSON_INVALID'
  | 'IMPORT_RECORD_LIMIT';

export class ImportParserError extends Error {
  constructor(readonly code: ImportParserFailureCode) {
    super(code);
  }
}

export interface ImportParserPlan {
  sheet?: string;
  encoding?: 'utf8' | 'utf16le' | 'windows1258' | 'latin1';
  delimiter?: 'comma' | 'semicolon' | 'tab' | 'pipe';
}

interface KmlFeature {
  type: 'Feature';
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
}

export async function parseImportRecords(
  content: Buffer,
  format: ImportFormat,
  plan: ImportParserPlan,
  maxRecords: number,
): Promise<unknown[]> {
  if (format === 'geojson') return parseGeoJson(content, maxRecords);
  if (format === 'csv') return parseCsvRows(content, plan, maxRecords);
  if (format === 'xlsx') return parseXlsxRows(content, plan, maxRecords);
  return parseKml(content, maxRecords);
}

export async function inspectXlsxSheets(content: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(content).buffer);
  } catch {
    throw new ImportParserError('XLSX_INVALID');
  }
  if (workbook.worksheets.length < 1) throw new ImportParserError('XLSX_INVALID');
  if (workbook.worksheets.length > MAX_XLSX_SHEETS) {
    throw new ImportParserError('XLSX_SHEET_LIMIT');
  }
  return workbook.worksheets.map((sheet) => sheet.name);
}

export function parseWktGeometry(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) {
    throw new ImportParserError('WKT_INVALID');
  }
  const srid = /^\s*SRID=(\d+);/i.exec(value)?.[1];
  if (srid !== undefined && srid !== '4326') throw new ImportParserError('WKT_INVALID');
  try {
    return WkxGeometry.parse(value).toGeoJSON();
  } catch (error) {
    if (error instanceof ImportParserError) throw error;
    throw new ImportParserError('WKT_INVALID');
  }
}

function parseGeoJson(content: Buffer, maxRecords: number): unknown[] {
  let payload: unknown;
  try {
    payload = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new ImportParserError('GEOJSON_INVALID');
  }
  if (!payload || typeof payload !== 'object') throw new ImportParserError('GEOJSON_INVALID');
  const object = payload as { type?: unknown; features?: unknown };
  const features =
    object.type === 'FeatureCollection' && Array.isArray(object.features)
      ? object.features
      : object.type === 'Feature'
        ? [object]
        : null;
  if (!features) throw new ImportParserError('GEOJSON_INVALID');
  if (features.length > maxRecords) throw new ImportParserError('IMPORT_RECORD_LIMIT');
  return features;
}

function parseCsvRows(
  content: Buffer,
  plan: ImportParserPlan,
  maxRecords: number,
): Array<Record<string, unknown>> {
  let records: unknown;
  const encoding = plan.encoding ?? 'utf8';
  const source =
    encoding === 'windows1258' ? iconv.decode(content, 'windows1258').normalize('NFC') : content;
  const delimiters = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' } as const;
  try {
    records = parseCsv(source, {
      bom: true,
      columns: (headers: string[]) => validateHeaders(headers),
      delimiter: delimiters[plan.delimiter ?? 'comma'],
      encoding: encoding === 'windows1258' ? undefined : encoding,
      max_record_size: 64 * 1024,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      to: maxRecords + 2,
    }) as unknown;
  } catch (error) {
    if (error instanceof ImportParserError) throw error;
    throw new ImportParserError('CSV_INVALID');
  }
  if (!Array.isArray(records)) throw new ImportParserError('CSV_INVALID');
  if (records.length > maxRecords) throw new ImportParserError('IMPORT_RECORD_LIMIT');
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new ImportParserError('CSV_INVALID');
    }
    return record as Record<string, unknown>;
  });
}

async function parseXlsxRows(
  content: Buffer,
  plan: ImportParserPlan,
  maxRecords: number,
): Promise<Array<Record<string, unknown>>> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(content).buffer);
  } catch {
    throw new ImportParserError('XLSX_INVALID');
  }
  if (workbook.worksheets.length < 1) throw new ImportParserError('XLSX_INVALID');
  if (workbook.worksheets.length > MAX_XLSX_SHEETS) {
    throw new ImportParserError('XLSX_SHEET_LIMIT');
  }
  const sheet = plan.sheet ? workbook.getWorksheet(plan.sheet) : undefined;
  if (!sheet) throw new ImportParserError('XLSX_SHEET_NOT_FOUND');
  if (sheet.actualColumnCount > MAX_IMPORT_COLUMNS) {
    throw new ImportParserError('IMPORT_COLUMN_LIMIT');
  }
  const populatedRows: ExcelJS.Row[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => populatedRows.push(row));
  const headerRow = populatedRows.shift();
  if (!headerRow) throw new ImportParserError('XLSX_INVALID');
  const headers = validateHeaders(
    Array.from({ length: Math.max(headerRow.cellCount, sheet.actualColumnCount) }, (_, index) =>
      scalarText(cellValue(headerRow.getCell(index + 1))),
    ),
  );
  if (populatedRows.length > maxRecords) throw new ImportParserError('IMPORT_RECORD_LIMIT');
  return populatedRows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, cellValue(row.getCell(index + 1))])),
  );
}

function validateHeaders(headers: string[]): string[] {
  if (headers.length < 1 || headers.length > MAX_IMPORT_COLUMNS) {
    throw new ImportParserError('IMPORT_COLUMN_LIMIT');
  }
  const normalized = headers.map(normalizeImportColumnName);
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  if (
    normalized.some(
      (header) => !header || header.length > 200 || forbidden.has(header.toLowerCase()),
    )
  ) {
    throw new ImportParserError('CSV_INVALID');
  }
  if (new Set(normalized).size !== normalized.length) throw new ImportParserError('CSV_INVALID');
  return normalized;
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return String(value ?? '');
  const record = value as unknown as Record<string, unknown>;
  if ('result' in record) return scalarCellValue(record.result);
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        return scalarText((part as Record<string, unknown>).text);
      })
      .join('');
  }
  if (typeof record.text === 'string') return record.text;
  return String(cell.text);
}

function scalarCellValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return null;
}

function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function parseKml(content: Buffer, maxRecords: number): KmlFeature[] {
  const xml = content.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY|<(?:\w+:)?NetworkLink\b/i.test(xml)) {
    throw new ImportParserError('KML_UNSAFE_XML');
  }
  assertXmlShape(xml);
  let document: unknown;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: false,
      trimValues: true,
    }).parse(xml) as unknown;
  } catch {
    throw new ImportParserError('KML_INVALID');
  }
  const placemarks: Record<string, unknown>[] = [];
  collectNamedRecords(document, 'Placemark', placemarks);
  if (placemarks.length > maxRecords) throw new ImportParserError('IMPORT_RECORD_LIMIT');
  if (!placemarks.length) throw new ImportParserError('KML_INVALID');
  return placemarks.map((placemark) => ({
    type: 'Feature',
    geometry: kmlGeometry(placemark),
    properties: kmlProperties(placemark),
  }));
}

function collectNamedRecords(
  value: unknown,
  name: string,
  output: Array<Record<string, unknown>>,
): void {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > 500_000) throw new ImportParserError('KML_STRUCTURE_LIMIT');
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) stack.push(item);
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (key === name) {
          for (const candidate of asArray(child)) {
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
              output.push(candidate as Record<string, unknown>);
            }
          }
        } else {
          stack.push(child);
        }
      }
    }
  }
}

function kmlProperties(placemark: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of ['name', 'description']) {
    const value = nodeText(placemark[key]);
    if (value !== null) properties[key] = value;
  }
  const dataNodes: Record<string, unknown>[] = [];
  collectNamedRecords(placemark.ExtendedData, 'Data', dataNodes);
  collectNamedRecords(placemark.ExtendedData, 'SimpleData', dataNodes);
  for (const data of dataNodes) {
    const name = data['@_name'];
    const value = nodeText(data.value ?? data['#text']);
    if (typeof name === 'string' && name && value !== null) properties[name] = value;
  }
  return properties;
}

function kmlGeometry(placemark: Record<string, unknown>): Record<string, unknown> {
  const geometries = extractKmlGeometries(placemark);
  if (geometries.length === 1) return geometries[0]!;
  const types = new Set(geometries.map((geometry) => geometry.type));
  if (types.size !== 1 || geometries.length < 1) throw new ImportParserError('KML_INVALID');
  const type = String(geometries[0]!.type);
  if (type === 'Point') {
    return { type: 'MultiPoint', coordinates: geometries.map((geometry) => geometry.coordinates) };
  }
  if (type === 'LineString') {
    return {
      type: 'MultiLineString',
      coordinates: geometries.map((geometry) => geometry.coordinates),
    };
  }
  if (type === 'Polygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometries.map((geometry) => geometry.coordinates),
    };
  }
  throw new ImportParserError('KML_INVALID');
}

function extractKmlGeometries(value: unknown): Array<Record<string, unknown>> {
  const geometries: Array<Record<string, unknown>> = [];
  const stack = asArray(value);
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > 500_000) throw new ImportParserError('KML_STRUCTURE_LIMIT');
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key === 'Point') {
        for (const point of asArray(child)) {
          const coordinates = parseCoordinates(nodeField(point, 'coordinates'));
          if (coordinates.length !== 1) throw new ImportParserError('KML_INVALID');
          geometries.push({ type: 'Point', coordinates: coordinates[0] });
        }
      } else if (key === 'LineString') {
        for (const line of asArray(child)) {
          geometries.push({
            type: 'LineString',
            coordinates: parseCoordinates(nodeField(line, 'coordinates')),
          });
        }
      } else if (key === 'Polygon') {
        for (const polygon of asArray(child)) geometries.push(parseKmlPolygon(polygon));
      } else if (key === 'MultiGeometry') {
        stack.push(...asArray(child));
      }
    }
  }
  return geometries;
}

function parseKmlPolygon(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new ImportParserError('KML_INVALID');
  const polygon = value as Record<string, unknown>;
  const outer = firstNamedText(polygon.outerBoundaryIs, 'coordinates');
  if (outer === null) throw new ImportParserError('KML_INVALID');
  const rings: number[][][] = [parseCoordinates(outer)];
  const innerBoundaries = asArray(polygon.innerBoundaryIs);
  for (const boundary of innerBoundaries) {
    const inner = firstNamedText(boundary, 'coordinates');
    if (inner === null) throw new ImportParserError('KML_INVALID');
    rings.push(parseCoordinates(inner));
  }
  return { type: 'Polygon', coordinates: rings };
}

function firstNamedText(value: unknown, name: string): string | null {
  const stack = asArray(value);
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > 500_000) throw new ImportParserError('KML_STRUCTURE_LIMIT');
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) stack.push(item);
    } else if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (name in record) return nodeText(record[name]);
      stack.push(...Object.values(record));
    }
  }
  return null;
}

function nodeField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function nodeText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string' || typeof text === 'number') return String(text).trim();
  }
  return null;
}

function assertXmlShape(xml: string): void {
  const tags = xml.match(/<[^>]*>/g) ?? [];
  if (tags.length > 500_000) throw new ImportParserError('KML_STRUCTURE_LIMIT');
  let depth = 0;
  for (const tag of tags) {
    if (/^<\//.test(tag)) {
      depth = Math.max(0, depth - 1);
    } else if (!/^<\?|^<!|\/>$/.test(tag)) {
      depth += 1;
      if (depth > 128) throw new ImportParserError('KML_STRUCTURE_LIMIT');
    }
  }
}

function parseCoordinates(value: unknown): number[][] {
  const text = nodeText(value);
  if (!text) throw new ImportParserError('KML_INVALID');
  const coordinates = text
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => {
      const values = tuple.split(',').slice(0, 2).map(Number);
      if (values.length !== 2 || values.some((item) => !Number.isFinite(item))) {
        throw new ImportParserError('KML_INVALID');
      }
      return values as [number, number];
    });
  if (!coordinates.length) throw new ImportParserError('KML_INVALID');
  return coordinates;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}
