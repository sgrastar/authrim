import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_MACHINE_AUDIENCE,
  ADMIN_UI_BFF_CLIENT_ID,
  ADMIN_UI_BFF_SCOPES,
  SETUP_MACHINE_CLIENT_ID,
  SETUP_MACHINE_CREDENTIAL_LEASE_SECONDS,
  SETUP_MACHINE_DEFAULT_SCOPES,
  adminUiBffKeyFilesExist,
  buildAdminUiBffMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  buildSetupMachineAccessBootstrapSql,
  createSetupMachineClientAssertion,
  deleteSetupMachineKeyFiles,
  ensureSetupMachineKeyFiles,
  getSetupMachinePrivateKeyPath,
  getSetupMachinePublicJwkPath,
  loadAdminUiBffPublicJwk,
  loadSetupMachinePublicJwk,
  setupMachineKeyFilesExist,
} from '../core/admin-machine-access.js';
import { createDefaultConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { AUTHRIM_KEYS_DIR } from '../core/paths.js';

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

describe('Admin Machine Access setup bootstrap', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      `.test-admin-machine-access-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('saves and loads setup machine key files', async () => {
    const secrets = generateAllSecrets('setup-bootstrap-test');
    await saveKeysToDirectory(secrets, { keysBaseDir: testDir, env: 'prod' });

    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    expect(setupMachineKeyFilesExist(keysDir)).toBe(true);

    const publicJwk = await loadSetupMachinePublicJwk(keysDir);
    expect(publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      kid: 'setup-bootstrap-test-setup',
    });
  });

  it('saves and loads Admin UI BFF machine key files', async () => {
    const secrets = generateAllSecrets('admin-ui-bff-test');
    await saveKeysToDirectory(secrets, { keysBaseDir: testDir, env: 'prod' });

    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    expect(adminUiBffKeyFilesExist(keysDir)).toBe(true);

    const publicJwk = await loadAdminUiBffPublicJwk(keysDir);
    expect(publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      kid: 'admin-ui-bff-test-admin-ui-bff',
    });
  });

  it('builds idempotent DB_ADMIN bootstrap SQL for setup_tool principal', async () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'acme';
    const secrets = generateAllSecrets('setup-sql-test');
    const sql = buildSetupMachineAccessBootstrapSql(
      config,
      secrets.setupMachineKeyPair.publicKeyJwk
    );

    expect(sql).toContain('INSERT INTO admin_machine_principals');
    expect(sql).toContain("'authrim-setup'");
    expect(sql).toContain("'setup_tool'");
    expect(sql).toContain('INSERT INTO admin_machine_credentials');
    expect(sql).toContain("'ES256'");
    expect(sql).toContain('INSERT INTO admin_machine_principal_permissions');
    expect(sql).toContain('VALUES');
    expect(sql).toContain("'admin:clients:*'");
    expect(sql).not.toContain('UNION ALL');
    expect(sql).toContain('INSERT INTO admin_machine_principal_tenant_scopes');
    expect(sql).toContain("'allow'");
    expect(sql).toContain("'acme'");
    expect(sql).not.toContain('INSERT OR IGNORE');
    expect(SETUP_MACHINE_CREDENTIAL_LEASE_SECONDS).toBe(30 * 60);
    expect(SETUP_MACHINE_CREDENTIAL_LEASE_SECONDS).toBeGreaterThan(600);
    expect(sql.match(/expires_at = \(\(unixepoch\(\) \* 1000\) \+ 1800000\)/g)).toHaveLength(1);
    expect(sql).toContain("'active',\n  NULL,\n  ((unixepoch() * 1000) + 1800000),");
  });

  it('renews the same setup credential into a fresh bounded lease', () => {
    const config = createDefaultConfig('prod');
    const secrets = generateAllSecrets('setup-renew-test');
    const sql = buildSetupMachineAccessBootstrapSql(
      config,
      secrets.setupMachineKeyPair.publicKeyJwk
    );

    expect(sql).toContain(
      "WHERE principal_id = 'amp_authrim_setup'\n  AND kid = 'setup-renew-test-setup'"
    );
    expect(sql).toContain('not_before = NULL');
    expect(sql).toContain('expires_at = ((unixepoch() * 1000) + 1800000)');
    expect(sql).toContain('revoked_at = NULL');
    expect(sql).toContain("WHEN status IN ('active', 'rotating') THEN 'expired'");
    expect(sql).toContain('expires_at = (unixepoch() * 1000)');
    expect(sql.indexOf('UPDATE admin_machine_credentials')).toBeLessThan(
      sql.indexOf('INSERT INTO admin_machine_principals')
    );
    expect(sql).toContain("WHERE principal_id = 'amp_authrim_setup';");
  });

  it('leaves a bounded credential after a crash-equivalent missing cleanup', () => {
    const config = createDefaultConfig('prod');
    const secrets = generateAllSecrets('setup-crash-test');
    const bootstrapSql = buildSetupMachineAccessBootstrapSql(
      config,
      secrets.setupMachineKeyPair.publicKeyJwk
    );

    // A terminated setup process cannot run cleanup, so the bootstrap SQL itself
    // must contain the fail-closed expiry for both create and retry paths.
    expect(bootstrapSql).toContain("'active',\n  NULL,\n  ((unixepoch() * 1000) + 1800000),");
    expect(bootstrapSql).toContain('expires_at = ((unixepoch() * 1000) + 1800000)');
  });

  it('builds setup machine cleanup SQL without touching Admin UI BFF principal', () => {
    const sql = buildSetupMachineAccessCleanupSql();

    expect(sql).toContain('DELETE FROM admin_machine_assertion_jti');
    expect(sql).toContain('DELETE FROM admin_machine_resource_scopes');
    expect(sql).toContain('DELETE FROM admin_machine_credentials');
    expect(sql).toContain('DELETE FROM admin_machine_principals');
    expect(sql).toContain("'authrim-setup'");
    expect(sql).toContain("'amp_authrim_setup'");
    expect(sql).toContain("principal_type = 'setup_tool'");
    expect(sql).not.toContain(ADMIN_UI_BFF_CLIENT_ID);
  });

  it('regenerates and deletes deploy-only setup machine key files', async () => {
    const secrets = generateAllSecrets('ephemeral-setup-test');
    await saveKeysToDirectory(secrets, { keysBaseDir: testDir, env: 'prod' });

    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    await deleteSetupMachineKeyFiles(keysDir);
    expect(setupMachineKeyFilesExist(keysDir)).toBe(false);

    const result = await ensureSetupMachineKeyFiles(keysDir);
    expect(result.created).toBe(true);
    expect(existsSync(getSetupMachinePrivateKeyPath(keysDir))).toBe(true);
    expect(existsSync(getSetupMachinePublicJwkPath(keysDir))).toBe(true);

    await deleteSetupMachineKeyFiles(keysDir);
    expect(setupMachineKeyFilesExist(keysDir)).toBe(false);
    expect(adminUiBffKeyFilesExist(keysDir)).toBe(true);
  });

  it('supports a unique key ID for isolated short-lived machine principals', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'isolated-export');
    await ensureSetupMachineKeyFiles(keysDir, 'authrim-rp-evidence-unique');

    const publicJwk = await loadSetupMachinePublicJwk(keysDir);
    expect(publicJwk.kid).toBe('authrim-rp-evidence-unique');
  });

  it('recovers an interrupted partial setup-machine key generation', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'interrupted-setup');
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    writeFileSync(getSetupMachinePrivateKeyPath(keysDir), 'partial', { mode: 0o600 });

    await expect(ensureSetupMachineKeyFiles(keysDir, 'authrim-recovered-setup')).resolves.toEqual({
      created: true,
    });
    expect(setupMachineKeyFilesExist(keysDir)).toBe(true);
    await expect(loadSetupMachinePublicJwk(keysDir)).resolves.toMatchObject({
      kid: 'authrim-recovered-setup',
      alg: 'ES256',
    });
  });

  it('builds idempotent DB_ADMIN bootstrap SQL for admin_ui_bff principal', async () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'acme';
    const secrets = generateAllSecrets('admin-ui-bff-sql-test');
    const sql = buildAdminUiBffMachineAccessBootstrapSql(
      config,
      secrets.adminUiBffMachineKeyPair.publicKeyJwk
    );

    expect(sql).toContain('INSERT INTO admin_machine_principals');
    expect(sql).toContain(`'${ADMIN_UI_BFF_CLIENT_ID}'`);
    expect(sql).toContain("'admin_ui_bff'");
    expect(sql).toContain('INSERT INTO admin_machine_credentials');
    expect(sql).toContain("'ES256'");
    expect(sql).toContain('INSERT INTO admin_machine_principal_permissions');
    expect(sql).toContain('VALUES');
    expect(sql).toContain("'admin-ui:proxy'");
    expect(sql).not.toContain('UNION ALL');
    expect(sql).toContain('INSERT INTO admin_machine_principal_tenant_scopes');
    expect(sql).toContain("'allow'");
    expect(sql).toContain("'acme'");
    expect(sql).not.toContain("'*'");
    expect(sql).not.toContain('INSERT OR IGNORE');
    expect(sql).toContain("'active',\n  NULL,\n  NULL,");
    expect(sql).not.toContain('expires_at = ((unixepoch() * 1000) + 1800000)');
  });

  it('creates a private_key_jwt client assertion for token issuance', async () => {
    const secrets = generateAllSecrets('setup-assertion-test');
    await saveKeysToDirectory(secrets, { keysBaseDir: testDir, env: 'prod' });
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');

    const assertion = await createSetupMachineClientAssertion({
      keysDir,
      tokenEndpoint: 'https://auth.example.com/token',
      nowEpoch: 1000,
    });
    const [headerSegment, payloadSegment, signatureSegment] = assertion.split('.');
    const header = decodeJwtSegment(headerSegment);
    const payload = decodeJwtSegment(payloadSegment);

    expect(signatureSegment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(header).toMatchObject({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'setup-assertion-test-setup',
    });
    expect(payload).toMatchObject({
      iss: SETUP_MACHINE_CLIENT_ID,
      sub: SETUP_MACHINE_CLIENT_ID,
      aud: 'https://auth.example.com/token',
      iat: 1000,
      exp: 1300,
    });
  });

  it('keeps setup scopes explicit and non-root', () => {
    expect(SETUP_MACHINE_DEFAULT_SCOPES).toContain('admin:clients:*');
    expect(SETUP_MACHINE_DEFAULT_SCOPES).not.toContain('*');
    expect(ADMIN_UI_BFF_SCOPES).toEqual(['admin-ui:proxy']);
    expect(ADMIN_MACHINE_AUDIENCE).toBe('authrim:admin-api');
  });
});
