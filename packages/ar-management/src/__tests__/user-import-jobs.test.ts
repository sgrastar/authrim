import { describe, expect, it } from 'vitest';
import {
  assertUserImportJobStorageKeys,
  buildUserImportResultKey,
  buildUserImportUploadKey,
  parseUserImportCsv,
  sanitizeUserImportFilename,
} from '../user-import-jobs';

describe('user-import-jobs helpers', () => {
  it('sanitizes filenames for upload keys', () => {
    expect(sanitizeUserImportFilename('../users import?.csv')).toBe('..-users-import-.csv');
    expect(buildUserImportUploadKey('tenant-a', 'upload-1', '../users import?.csv')).toBe(
      'imports/tenant-a/upload-1/..-users-import-.csv'
    );
    expect(buildUserImportResultKey('tenant-a', 'job-1')).toBe(
      'exports/tenant-a/users-import/job-1/result.json'
    );
  });

  it('rejects cross-tenant import and result object keys', () => {
    expect(() =>
      assertUserImportJobStorageKeys({
        id: 'job-1',
        tenant_id: 'tenant-a',
        input_r2_key: 'imports/tenant-b/upload-1/users.csv',
        result_r2_key: buildUserImportResultKey('tenant-a', 'job-1'),
      })
    ).toThrow('input_r2_key does not belong to the job tenant');

    expect(() =>
      assertUserImportJobStorageKeys({
        id: 'job-1',
        tenant_id: 'tenant-a',
        input_r2_key: buildUserImportUploadKey('tenant-a', 'upload-1', 'users.csv'),
        result_r2_key: buildUserImportResultKey('tenant-b', 'job-1'),
      })
    ).toThrow('result_r2_key does not belong to the job tenant');
  });

  it('parses header-based CSV with quoted fields', () => {
    const csv = [
      'email,name,custom_note',
      'alice@example.com,"Alice, Example","{""tier"":""gold""}"',
      'bob@example.com,Bob,hello',
    ].join('\n');

    const parsed = parseUserImportCsv(csv, { skip_header: true });

    expect(parsed.headers).toEqual(['email', 'name', 'custom_note']);
    expect(parsed.records).toEqual([
      {
        email: 'alice@example.com',
        name: 'Alice, Example',
        custom_note: '{"tier":"gold"}',
      },
      {
        email: 'bob@example.com',
        name: 'Bob',
        custom_note: 'hello',
      },
    ]);
  });

  it('uses default positional headers when skip_header is false', () => {
    const csv = 'alice@example.com,Alice,true';
    const parsed = parseUserImportCsv(csv, { skip_header: false });

    expect(parsed.headers.slice(0, 3)).toEqual(['email', 'name', 'given_name']);
    expect(parsed.records[0]).toEqual({
      email: 'alice@example.com',
      name: 'Alice',
      given_name: 'true',
    });
  });
});
