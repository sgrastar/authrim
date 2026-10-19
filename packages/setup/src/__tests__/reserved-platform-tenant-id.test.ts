import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isReservedPlatformTenantId,
  PLATFORM_MAPPING_TENANT_ID,
} from '@authrim/ar-lib-core/services/identity-mapping-owner';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import {
  buildInitialAdminRolesBootstrapSql,
  buildInitialTenantBootstrapSql,
  ensureInitialTenantInD1,
  RESERVED_TENANT_ROWS_QUERY_SQL,
} from '../core/cloudflare.js';
import { createDefaultConfig, TenantConfigSchema, TenantIdSchema } from '../core/config.js';
import {
  isReservedTenantId,
  isValidTenantId,
  RESERVED_PLATFORM_TENANT_ID,
} from '../core/tenant-id.js';
import en from '../i18n/locales/en.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { getHtmlTemplate } from '../web/ui.js';

const RESERVED = ['platform', 'Platform', 'PLATFORM', ' platform', 'platform ', '\tplatform\n'];
const NOT_RESERVED = ['platform-eu', 'my-platform', 'platform2', 'default', 'first', ''];

describe('reserved platform tenant ID in setup', () => {
  beforeEach(() => {
    execaMock.mockReset();
    // The Cloudflare API fallback must never reach a real account from a test.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CLOUDFLARE_D1_API_TOKEN', '');
  });

  it('names the same ID as ar-lib-core', () => {
    expect(RESERVED_PLATFORM_TENANT_ID).toBe(PLATFORM_MAPPING_TENANT_ID);
  });

  it.each([...RESERVED, ...NOT_RESERVED])('uses the same rule as ar-lib-core for %j', (value) => {
    expect(isReservedTenantId(value)).toBe(isReservedPlatformTenantId(value));
  });

  it.each(RESERVED)('rejects %j as a tenant ID', (value) => {
    expect(isValidTenantId(value)).toBe(false);
    expect(TenantIdSchema.safeParse(value).success).toBe(false);
    expect(TenantConfigSchema.safeParse({ name: value }).success).toBe(false);
  });

  it('still accepts IDs that only contain the word', () => {
    for (const value of ['platform-eu', 'my-platform', 'platform2']) {
      expect(isValidTenantId(value)).toBe(true);
      expect(TenantIdSchema.safeParse(value).success).toBe(true);
    }
  });

  it('is rejected by the Web setup form as well', () => {
    const html = getHtmlTemplate('session-token', false, 'en', en, SUPPORTED_LOCALES);
    const source = /function isValidTenantId\(value\) \{[\s\S]*?\n {4}\}/.exec(html)?.[0];
    expect(source).toBeDefined();
    const isValidInBrowser = vm.runInNewContext(`(${source})`) as (value: string) => boolean;

    for (const value of RESERVED) expect(isValidInBrowser(value)).toBe(false);
    for (const value of ['platform-eu', 'default', 'first']) {
      expect(isValidInBrowser(value)).toBe(true);
    }
  });

  it.each(RESERVED)('refuses to build the initial tenant SQL for %j', (value) => {
    const config = createDefaultConfig('mt');
    config.tenant.name = value;

    expect(() => buildInitialTenantBootstrapSql(config)).toThrow(/reserved/);
    expect(() => buildInitialAdminRolesBootstrapSql(config)).toThrow(/reserved/);
  });

  it('refuses the initial tenant without touching the database', async () => {
    const config = createDefaultConfig('mt');
    config.tenant.name = 'platform';

    const result = await ensureInitialTenantInD1('mt', config);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('reserved') });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('finds tenants registered under the reserved ID or code, and only those', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY, tenant_code TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO tenants VALUES (?, ?)');
    insert.run('default', 'default');
    insert.run('platform-eu', 'platform-eu');
    expect(db.prepare(RESERVED_TENANT_ROWS_QUERY_SQL).all()).toEqual([]);

    insert.run('platform', 'platform');
    insert.run('acme', 'Platform');
    insert.run(' Platform ', 'x');
    expect(db.prepare(RESERVED_TENANT_ROWS_QUERY_SQL).all()).toHaveLength(3);
  });

  it('stops before writing when a tenant already holds the reserved ID or code', async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { success: true, results: [{ id: 'acme', tenant_code: 'platform' }] },
      ]),
    });
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    const result = await ensureInitialTenantInD1('mt', config);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('platform') });
    expect(execaMock).toHaveBeenCalledTimes(1);
    const sql = String(execaMock.mock.calls[0][1].at(-2));
    expect(sql).toBe(RESERVED_TENANT_ROWS_QUERY_SQL);
  });

  it.each([
    ['a failed result entry', JSON.stringify([{ success: false, results: [] }]), ''],
    ['a lone empty list', '[]', ''],
    ['an entry that does not report success', JSON.stringify([{ results: [] }]), ''],
    ['a failure response', JSON.stringify({ success: false, result: [] }), ''],
    ['empty output', '', ''],
    ['output that cannot be parsed', 'wrangler: something went wrong', ''],
    [
      'a failed result among noise',
      'banner\n' + JSON.stringify([{ success: false, results: [] }]),
      '',
    ],
    ['a failed result on stderr', '', JSON.stringify([{ success: false, results: [] }])],
    [
      'a success on stdout and a failure on stderr',
      JSON.stringify([{ success: true, results: [] }]),
      JSON.stringify([{ success: false, results: [] }]),
    ],
    [
      'a long success and a short failure in one stream',
      JSON.stringify([
        { success: true, results: [], meta: { duration: 1, note: 'x'.repeat(80) } },
      ]) +
        '\n' +
        JSON.stringify([{ success: false, results: [] }]),
      '',
    ],
    [
      'a failure before a long success in one stream',
      JSON.stringify([{ success: false, results: [] }]) +
        '\n' +
        JSON.stringify([{ success: true, results: [], meta: { note: 'x'.repeat(80) } }]),
      '',
    ],
    [
      'two successful results in one stream',
      JSON.stringify([{ success: true, results: [] }]) +
        '\n' +
        JSON.stringify([{ success: true, results: [{ id: 'acme', tenant_code: 'platform' }] }]),
      '',
    ],
    [
      'a successful result on each stream',
      JSON.stringify([{ success: true, results: [] }]),
      JSON.stringify([{ success: true, results: [] }]),
    ],
    [
      'a success followed by a lone empty list',
      JSON.stringify([{ success: true, results: [] }]) + '\n[]',
      '',
    ],
    [
      'one failed entry among successful ones',
      JSON.stringify([
        { success: true, results: [] },
        { success: false, results: [] },
      ]),
      '',
    ],
  ])('does not write when the reserved-tenant check returns %s', async (_name, stdout, stderr) => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout, stderr });
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    const result = await ensureInitialTenantInD1('mt', config);

    expect(result.success).toBe(false);
    // Only the check ran (plus the fallback's own attempts, none of which is a write).
    for (const [, args] of execaMock.mock.calls as Array<[string, string[]]>) {
      expect(args).toContain('--json');
    }
  });

  it('takes a successful empty result, also from noisy output, as finding nothing', async () => {
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stderr: '',
      stdout: args.includes('--json')
        ? 'banner\n' + JSON.stringify([{ success: true, results: [] }])
        : 'ok',
    }));
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    await expect(ensureInitialTenantInD1('mt', config)).resolves.toEqual({ success: true });
  });

  it('goes on to the bootstrap when no tenant holds the reserved ID or code', async () => {
    execaMock.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stderr: '',
      stdout: args.includes('--json') ? JSON.stringify([{ success: true, results: [] }]) : 'ok',
    }));
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    await expect(ensureInitialTenantInD1('mt', config)).resolves.toEqual({ success: true });
    expect(execaMock).toHaveBeenCalledTimes(2);
  });
});
