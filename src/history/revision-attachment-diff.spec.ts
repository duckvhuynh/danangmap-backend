import { buildAttachmentDiff, type AttachmentSideRow } from './revision-attachment-diff';

function row(
  input: Partial<AttachmentSideRow> & Pick<AttachmentSideRow, 'id' | 'side'>,
): AttachmentSideRow {
  return {
    featureId: '00000000-0000-4000-8000-000000000001',
    fieldKey: 'documents',
    displayOrder: 0,
    fileName: `${input.id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 12,
    status: 'clean',
    safePublic: true,
    ...input,
  };
}

describe('buildAttachmentDiff', () => {
  it('reports safe add, remove and reorder without infrastructure metadata', () => {
    const diff = buildAttachmentDiff([
      row({ id: 'shared', side: 'base', displayOrder: 0 }),
      row({ id: 'shared', side: 'current', displayOrder: 2 }),
      row({ id: 'removed', side: 'base', displayOrder: 1 }),
      row({ id: 'added', side: 'current', displayOrder: 1 }),
    ]);

    expect(diff).toMatchObject({
      available: true,
      changed: true,
      added: [{ id: 'added', displayOrder: 1 }],
      removed: [{ id: 'removed', displayOrder: 1 }],
      reordered: [{ id: 'shared', beforeDisplayOrder: 0, afterDisplayOrder: 2 }],
      redactedChange: false,
    });
    expect(JSON.stringify(diff)).not.toMatch(/objectKey|quarantine|sha256|ownerId/);
  });

  it('signals hidden association changes without disclosing their descriptors', () => {
    const diff = buildAttachmentDiff([
      row({
        id: 'private-before',
        side: 'base',
        fieldKey: 'private_documents',
        safePublic: false,
      }),
      row({
        id: 'private-after',
        side: 'current',
        fieldKey: 'private_documents',
        safePublic: false,
      }),
    ]);

    expect(diff).toEqual({
      available: true,
      changed: true,
      added: [],
      removed: [],
      reordered: [],
      redactedChange: true,
    });
    expect(JSON.stringify(diff)).not.toContain('private-before');
    expect(JSON.stringify(diff)).not.toContain('private-after');
  });

  it('treats a public visibility transition as a safe projection change', () => {
    const diff = buildAttachmentDiff([
      row({ id: 'same', side: 'base', safePublic: false }),
      row({ id: 'same', side: 'current', safePublic: true }),
    ]);

    expect(diff.added).toEqual([expect.objectContaining({ id: 'same' })]);
    expect(diff.removed).toEqual([]);
    expect(diff.redactedChange).toBe(false);
  });

  it('does not redact visibility flip with simultaneous display order change', () => {
    const diffPrivateToPublic = buildAttachmentDiff([
      row({ id: 'same', side: 'base', safePublic: false, displayOrder: 1 }),
      row({ id: 'same', side: 'current', safePublic: true, displayOrder: 2 }),
    ]);

    expect(diffPrivateToPublic.added).toEqual([
      expect.objectContaining({ id: 'same', displayOrder: 2 }),
    ]);
    expect(diffPrivateToPublic.removed).toEqual([]);
    expect(diffPrivateToPublic.redactedChange).toBe(false);

    const diffPublicToPrivate = buildAttachmentDiff([
      row({ id: 'same', side: 'base', safePublic: true, displayOrder: 1 }),
      row({ id: 'same', side: 'current', safePublic: false, displayOrder: 2 }),
    ]);

    expect(diffPublicToPrivate.added).toEqual([]);
    expect(diffPublicToPrivate.removed).toEqual([
      expect.objectContaining({ id: 'same', displayOrder: 1 }),
    ]);
    expect(diffPublicToPrivate.redactedChange).toBe(false);
  });
});
