import ExcelJS from 'exceljs';
import {
  detectUserImport,
  inspectUserImport,
  normalizeUserImportRow,
  parseUserImport,
  UserImportParserError,
} from '../src/user-imports/user-import.parser';

describe('User import parser', () => {
  it('normalizes the fixed CSV identity schema without accepting credentials', async () => {
    const content = Buffer.from(
      [
        'email,username,displayName,role',
        'phuong.hai-chau@example.gov.vn,phuong.hai-chau,Phường Hải Châu,editor',
      ].join('\n'),
    );
    const format = detectUserImport(file('accounts.csv', content));
    expect(format).toBe('csv');
    await expect(inspectUserImport(content, format)).resolves.toEqual({
      format: 'csv',
      sheets: [],
      headers: ['email', 'username', 'displayName', 'role'],
    });
    const [source] = await parseUserImport(content, format, null);
    expect(normalizeUserImportRow(source!)).toEqual({
      row: {
        rowNumber: 2,
        email: 'phuong.hai-chau@example.gov.vn',
        emailNormalized: 'phuong.hai-chau@example.gov.vn',
        username: 'phuong.hai-chau',
        usernameNormalized: 'phuong.hai-chau',
        displayName: 'Phường Hải Châu',
        role: 'editor',
      },
      issues: [],
    });
  });

  it.each(['password', 'mfaSecret', 'recoveryCode'])(
    'rejects privileged header %s instead of silently ignoring it',
    async (header) => {
      const content = Buffer.from(
        `email,username,displayName,${header}\na@b.vn,user.name,Name,value`,
      );
      await expect(inspectUserImport(content, 'csv')).rejects.toMatchObject({
        code: 'USER_IMPORT_FORBIDDEN_COLUMN',
      });
    },
  );

  it('requires the exact four-column order and enforces 5000 rows', async () => {
    await expect(
      inspectUserImport(
        Buffer.from('username,email,displayName,role\nuser.name,a@b.vn,Name,editor'),
        'csv',
      ),
    ).rejects.toMatchObject({ code: 'USER_IMPORT_COLUMNS_INVALID' });
    const rows = ['email,username,displayName,role'];
    for (let index = 0; index < 5001; index += 1) {
      rows.push(`u${index}@example.gov.vn,user.${index},User ${index},editor`);
    }
    await expect(parseUserImport(Buffer.from(rows.join('\n')), 'csv', null)).rejects.toMatchObject({
      code: 'USER_IMPORT_ROW_LIMIT',
    });
  });

  it('reads values-only XLSX from an explicitly selected sheet', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Guide').addRow(['Read me']);
    workbook.addWorksheet('Tài khoản').addRows([
      ['email', 'username', 'displayName', 'role'],
      ['publisher@example.gov.vn', 'publisher.import', 'Nhà xuất bản', 'publisher'],
    ]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(inspectUserImport(content, 'xlsx')).resolves.toMatchObject({
      sheets: ['Guide', 'Tài khoản'],
    });
    await expect(parseUserImport(content, 'xlsx', null)).rejects.toMatchObject({
      code: 'USER_IMPORT_SHEET_REQUIRED',
    });
    const [source] = await parseUserImport(content, 'xlsx', 'Tài khoản');
    expect(normalizeUserImportRow(source!).row).toMatchObject({
      emailNormalized: 'publisher@example.gov.vn',
      usernameNormalized: 'publisher.import',
      displayName: 'Nhà xuất bản',
      role: 'publisher',
    });
  });

  it('rejects formulas and unsafe OOXML package parts without evaluating them', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Accounts');
    sheet.addRow(['email', 'username', 'displayName', 'role']);
    sheet.addRow([
      'formula@example.gov.vn',
      'formula.user',
      { formula: 'HYPERLINK("https://attacker.invalid")', result: 'Formula User' },
      'editor',
    ]);
    const formula = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseUserImport(formula, 'xlsx', 'Accounts')).rejects.toMatchObject({
      code: 'USER_IMPORT_XLSX_FORMULA_FORBIDDEN',
    });

    const externalLink = centralDirectoryEntry('xl/externalLinks/externalLink1.xml', 64);
    await expect(inspectUserImport(externalLink, 'xlsx')).rejects.toMatchObject({
      code: 'USER_IMPORT_XLSX_UNSAFE',
    });
    const zipBomb = centralDirectoryEntry('xl/worksheets/sheet1.xml', 50 * 1024 * 1024 + 1);
    await expect(inspectUserImport(zipBomb, 'xlsx')).rejects.toMatchObject({
      code: 'USER_IMPORT_EXPANDED_SIZE_LIMIT',
    });
  });

  it('emits stable row-level errors for invalid identity values and roles', () => {
    const result = normalizeUserImportRow({
      rowNumber: 7,
      email: 'not-an-email',
      username: 'Admin User',
      displayName: '',
      role: 'owner',
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'USER_IMPORT_EMAIL_INVALID',
      'USER_IMPORT_USERNAME_INVALID',
      'USER_IMPORT_DISPLAY_NAME_INVALID',
      'USER_IMPORT_ROLE_INVALID',
    ]);
  });

  it('rejects content/extension mismatch', () => {
    const content = Buffer.from('email,username,displayName,role');
    expect(() => detectUserImport(file('accounts.xlsx', content))).toThrow(UserImportParserError);
  });
});

function file(name: string, content: Buffer): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    size: content.byteLength,
    buffer: content,
    destination: '',
    filename: name,
    path: '',
    stream: undefined as never,
  };
}

function centralDirectoryEntry(name: string, expandedBytes: number): Buffer {
  const encoded = Buffer.from(name);
  const content = Buffer.alloc(46 + encoded.byteLength);
  content.writeUInt32LE(0x02014b50, 0);
  content.writeUInt32LE(expandedBytes, 24);
  content.writeUInt16LE(encoded.byteLength, 28);
  encoded.copy(content, 46);
  return content;
}
