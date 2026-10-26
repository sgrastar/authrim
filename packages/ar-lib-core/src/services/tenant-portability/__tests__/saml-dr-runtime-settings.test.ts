import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types/env';
import { generateVersion } from '../../../utils/settings-manager';
import { hashIpAddress } from '../../../utils/consent-statements';
import {
  readSamlDrFlowRuntimeEnabled,
  readSamlDrRuntimeSettings,
} from '../saml-dr-runtime-settings';

function fixture() {
  const data = { 'feature.enable_login_runtime_flow': true };
  const rows = [
    { scope_type: 'platform', document_json: JSON.stringify(data), version: generateVersion(data) },
  ];
  const all = vi.fn(async () => ({ success: true, results: rows }));
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) }));
  const withSession = vi.fn(() => ({ prepare }));
  const secret = {
    secretRef: 'tenant:tenant-a:consent:ip-salt',
    active: { kid: 'salt-1', value: 's'.repeat(32), createdAt: 100 },
    updatedAt: 100,
  };
  const getExistingSecretRpc = vi.fn(async () => secret);
  const get = vi.fn(() => ({ getExistingSecretRpc }));
  const idFromName = vi.fn((name: string) => name);
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    DB_ADMIN: { withSession },
    KEY_MANAGER: { get, idFromName },
  } as unknown as Env;
  return { env, rows, all, withSession, secret, getExistingSecretRpc, idFromName };
}

describe('SAML DR source/runtime authority', () => {
  it('reads established primary settings and the same tenant secret without creating state', async () => {
    const f = fixture();
    await expect(readSamlDrRuntimeSettings(f.env, 'tenant-a')).resolves.toEqual({
      sourceFlowRuntimeEnabled: true,
      consentIpSalt: 's'.repeat(32),
    });
    expect(f.withSession).toHaveBeenCalledWith('first-primary');
    expect(f.idFromName).toHaveBeenCalledWith('tenant:tenant-a:consent:ip-salt');
    expect(f.getExistingSecretRpc).toHaveBeenCalledWith('tenant:tenant-a:consent:ip-salt');
  });
  it('honors explicit tenant false over the same platform flag', async () => {
    const f = fixture();
    const data = { 'feature.enable_login_runtime_flow': false };
    f.rows.push({
      scope_type: 'tenant',
      document_json: JSON.stringify(data),
      version: generateVersion(data),
    });
    await expect(readSamlDrFlowRuntimeEnabled(f.env, 'tenant-a')).resolves.toBe(false);
    await expect(readSamlDrRuntimeSettings(f.env, 'tenant-a')).rejects.toThrow(
      'saml_dr_runtime_settings_authority_unavailable'
    );
  });
  it.each(['missing', 'stale', 'duplicate', 'malformed'])(
    'rejects %s canonical settings',
    async (kind) => {
      const f = fixture();
      if (kind === 'missing') f.rows.splice(0);
      if (kind === 'stale') f.rows[0].version = 'stale';
      if (kind === 'duplicate') f.rows.push({ ...f.rows[0] });
      if (kind === 'malformed') f.rows[0].document_json = '{';
      await expect(readSamlDrFlowRuntimeEnabled(f.env, 'tenant-a')).rejects.toThrow(
        'saml_dr_runtime_settings_authority_unavailable'
      );
    }
  );
  it.each(['other-tenant', 'short', 'missing'])(
    'does not hash with %s secret or fall back to KV',
    async (kind) => {
      const f = fixture();
      if (kind === 'other-tenant') f.secret.secretRef = 'tenant:tenant-b:consent:ip-salt';
      if (kind === 'short') f.secret.active.value = 'short';
      if (kind === 'missing') f.getExistingSecretRpc.mockResolvedValue(null as never);
      const kv = { get: vi.fn(), put: vi.fn() };
      await expect(
        hashIpAddress('192.0.2.1', 'tenant-a', kv as unknown as KVNamespace, f.env)
      ).rejects.toThrow('saml_dr_runtime_settings_authority_unavailable');
      expect(kv.get).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
    }
  );
  it('hashes using the frozen authority and preserves legacy behavior when disabled', async () => {
    const f = fixture();
    const kv = { get: vi.fn(async () => 'legacy-salt'), put: vi.fn() };
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`${'s'.repeat(32)}:192.0.2.1`)
        )
      ),
      (b) => b.toString(16).padStart(2, '0')
    ).join('');
    await expect(
      hashIpAddress('192.0.2.1', 'tenant-a', kv as unknown as KVNamespace, f.env)
    ).resolves.toBe(expected);
    expect(kv.get).not.toHaveBeenCalled();
    f.env.ENABLE_SAML_DR_EXPORT = 'false';
    expect(await hashIpAddress('192.0.2.1', 'tenant-a', kv as unknown as KVNamespace, f.env)).toBe(
      await hashIpAddress('192.0.2.1', 'tenant-a', kv as unknown as KVNamespace)
    );
  });
});
