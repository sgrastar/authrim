import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSecondFactorRecoveryError,
  LAST_RESORT_RECOVERY_PATH,
  LAST_RESORT_RECOVERY_PERMISSION,
  normalizeRecoveryRequest,
  parseRecoveryResponse,
  recoverAdminSecondFactor,
  type RecoverAdminSecondFactorDeps,
} from '../core/admin-second-factor-recovery.js';
import { buildSetupMachineAccessBootstrapSql } from '../core/admin-machine-access.js';
import {
  describeRecovery,
  describeRecoveryResult,
} from '../cli/commands/admin-recover-second-factor.js';
import { getEnvironmentPaths } from '../core/paths.js';

const apiResponse = {
  admin: { id: 'admin-1', email: 'solo@example.com', tenant_id: 'default' },
  revoked_second_factors: 2,
  ended_sessions: 1,
  cancelled_recovery_requests: 0,
  reenroll_until: 1_900_000_000_000,
  sole_admin: true,
  audit_logged: true,
  notices: { emailed: true, email_recipients: 1, console: true },
};

function environment(): { baseDir: string } {
  const baseDir = mkdtempSync(join(tmpdir(), 'authrim-sf-recovery-'));
  const paths = getEnvironmentPaths({ baseDir, env: 'prod' });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, '{}');
  return { baseDir };
}

const config = {
  environment: { prefix: 'prod' },
  tenant: { name: 'default' },
  urls: { api: { custom: 'https://id.example.com' } },
} as never;

function deps(overrides: Partial<RecoverAdminSecondFactorDeps> = {}) {
  const release = vi.fn(async () => undefined);
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(apiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  const value: RecoverAdminSecondFactorDeps = {
    acquireLock: vi.fn(async () => ({
      lock: { env: 'prod', d1: { DB_ADMIN: { id: 'admin-db-id', name: 'prod-authrim-admin-db' } } },
      lockFilePath: '/x/lock.json',
      release,
    })) as never,
    listD1Databases: vi.fn(async () => []) as never,
    runEphemeral: vi.fn(async (input: { action: () => Promise<unknown> }) =>
      input.action()
    ) as never,
    requestToken: vi.fn(async () => ({
      accessToken: 'tok',
      tokenType: 'Bearer' as const,
      expiresIn: 600,
      scope: LAST_RESORT_RECOVERY_PERMISSION,
    })),
    fetch: fetch as never,
    readConfig: vi.fn(async () => config),
    ...overrides,
  };
  return { deps: value, release, fetch };
}

vi.mock('../core/fixed-d1-identity.js', () => ({ assertFixedD1ResourceIdentities: vi.fn() }));
vi.mock('../core/url-config.js', () => ({
  resolveIssuerUrl: vi.fn(() => 'https://id.example.com'),
}));

describe('admin second-factor last-resort recovery (setup)', () => {
  let baseDir: string;

  beforeEach(() => {
    ({ baseDir } = environment());
  });

  it('writes the short-lived principal with only the recovery permission and calls the API', async () => {
    const { deps: d, release, fetch } = deps();

    const result = await recoverAdminSecondFactor(
      { baseDir, env: 'prod', keysDir: '/keys', email: ' Solo@Example.com ', reason: 'lost' },
      d
    );

    expect(result).toMatchObject({
      admin: { id: 'admin-1', tenantId: 'default' },
      revokedSecondFactors: 2,
      soleAdmin: true,
    });
    expect(d.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'prod', requireExisting: true })
    );
    expect(d.runEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        env: 'prod',
        databaseIdentifier: 'admin-db-id',
        permissions: [LAST_RESORT_RECOVERY_PERMISSION],
        allTenants: true,
      })
    );
    expect(d.requestToken).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: [LAST_RESORT_RECOVERY_PERMISSION], tenantId: 'default' })
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`https://id.example.com${LAST_RESORT_RECOVERY_PATH}`);
    expect(JSON.parse(init.body)).toEqual({ email: 'solo@example.com', reason: 'lost' });
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(release).toHaveBeenCalledOnce();
  });

  it('surfaces the API refusal with its code and releases the lock', async () => {
    const { deps: d, release } = deps({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'admin_ambiguous', tenant_ids: ['default', 'b'] }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as never,
    });

    const failure = await recoverAdminSecondFactor(
      { baseDir, env: 'prod', keysDir: '/keys', email: 'solo@example.com' },
      d
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdminSecondFactorRecoveryError);
    expect(failure).toMatchObject({
      status: 409,
      code: 'admin_ambiguous',
      detail: { tenant_ids: ['default', 'b'] },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuses an environment whose lock file is missing before writing anything', async () => {
    const { deps: d } = deps({
      acquireLock: vi.fn(async () => {
        throw new Error('environment_not_found:prod');
      }) as never,
    });

    await expect(
      recoverAdminSecondFactor(
        { baseDir, env: 'prod', keysDir: '/keys', email: 'a@example.com' },
        d
      )
    ).rejects.toThrow('environment_not_found:prod');
    expect(d.runEphemeral).not.toHaveBeenCalled();
  });

  it('refuses a lock without an admin database', async () => {
    const release = vi.fn(async () => undefined);
    const { deps: d } = deps({
      acquireLock: vi.fn(async () => ({
        lock: { env: 'prod', d1: {} },
        lockFilePath: '/x',
        release,
      })) as never,
    });
    await expect(
      recoverAdminSecondFactor(
        { baseDir, env: 'prod', keysDir: '/keys', email: 'a@example.com' },
        d
      )
    ).rejects.toThrow('admin_database_required_for_admin_recovery');
    expect(d.runEphemeral).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ email: 'no-at-sign' }, 'admin_second_factor_recovery_email_invalid'],
    [
      { email: 'a@example.com', tenantId: 'Bad Tenant' },
      'admin_second_factor_recovery_tenant_invalid',
    ],
    [
      { email: 'a@example.com', reason: 'x'.repeat(201) },
      'admin_second_factor_recovery_reason_too_long',
    ],
  ])('rejects %j before touching the environment', (request, message) => {
    expect(() => normalizeRecoveryRequest(request)).toThrow(message);
  });

  it('rejects a malformed API answer', () => {
    expect(() => parseRecoveryResponse({ ...apiResponse, sole_admin: 'yes' })).toThrow(
      'admin_second_factor_recovery_response_invalid'
    );
    expect(parseRecoveryResponse(apiResponse).notices).toEqual({
      emailed: true,
      emailRecipients: 1,
      console: true,
    });
  });

  it('writes the given permissions instead of the default setup scopes', () => {
    const sql = buildSetupMachineAccessBootstrapSql(
      config,
      { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256', kid: 'kid-1' },
      { permissions: [LAST_RESORT_RECOVERY_PERMISSION], allTenants: true }
    );
    expect(sql).toContain("'admin:last_resort_recovery'");
    expect(sql).not.toContain("'admin:clients:*'");
    expect(sql).toMatch(/'all',\s*NULL,/);
    expect(
      buildSetupMachineAccessBootstrapSql(config, {
        kty: 'EC',
        crv: 'P-256',
        x: 'x',
        y: 'y',
        alg: 'ES256',
        kid: 'kid-1',
      })
    ).toMatch(/'allow',\s*'default',/);
  });

  it('says what will happen and warns when notices did not all go out', () => {
    expect(describeRecovery('prod', 'solo@example.com').join('\n')).toContain('cannot be undone');
    const lines = describeRecoveryResult(
      parseRecoveryResponse({
        ...apiResponse,
        audit_logged: false,
        notices: { emailed: false, email_recipients: 0, console: true },
      })
    ).join('\n');
    expect(lines).toContain('Not every notification email could be sent');
    expect(lines).toContain('audit log entry could not be written');
  });
});
