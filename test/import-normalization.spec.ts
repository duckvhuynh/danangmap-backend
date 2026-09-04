import {
  isSafeImportColumnName,
  normalizeImportColumnName,
  normalizeImportedFieldValue,
} from '../src/imports/import-normalization';

describe('Import normalization', () => {
  it('normalizes Vietnamese combining marks without weakening column-name safety', () => {
    const decomposed = 'Tên cơ quan'.normalize('NFD');
    expect(normalizeImportColumnName(` ${decomposed} `)).toBe('Tên cơ quan');
    expect(isSafeImportColumnName(decomposed)).toBe(true);
    expect(isSafeImportColumnName('__proto__')).toBe(false);
    expect(isSafeImportColumnName('name/drop')).toBe(false);
  });

  it('adds HTTPS to scheme-less website values and preserves explicit schemes', () => {
    expect(normalizeImportedFieldValue(' danang.gov.vn ', 'url')).toBe('https://danang.gov.vn');
    expect(normalizeImportedFieldValue('danang.gov.vn', 'text', 'website')).toBe(
      'https://danang.gov.vn',
    );
    expect(normalizeImportedFieldValue('danang.gov.vn', 'text', 'service_url')).toBe(
      'https://danang.gov.vn',
    );
    expect(normalizeImportedFieldValue('//danang.gov.vn/path', 'url')).toBe(
      'https://danang.gov.vn/path',
    );
    expect(normalizeImportedFieldValue('http://danang.gov.vn', 'url')).toBe('http://danang.gov.vn');
    expect(normalizeImportedFieldValue('mailto:contact@danang.gov.vn', 'url')).toBe(
      'mailto:contact@danang.gov.vn',
    );
    expect(normalizeImportedFieldValue('  ', 'url')).toBe('');
    expect(normalizeImportedFieldValue('danang.gov.vn', 'text')).toBe('danang.gov.vn');
  });
});
