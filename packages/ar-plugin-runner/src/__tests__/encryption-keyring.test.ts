import { describe, expect, it } from 'vitest';
import {
  pluginEncryptionKeyringFromEnv,
  pluginEncryptionSecretFor,
  validatePluginEncryptionKeyring,
} from '../encryption-keyring';
import type { PluginEncryptionKeyring } from '../encryption-keyring';
import type { PluginRunnerEnv } from '../types';

const activeSecret = 'a'.repeat(32);
const previousSecret = 'b'.repeat(32);

function env(overrides: Partial<PluginRunnerEnv> = {}): PluginRunnerEnv {
  return {
    PLUGIN_ENCRYPTION_KEY: activeSecret,
    ...overrides,
  } as PluginRunnerEnv;
}

describe('plugin encryption keyring', () => {
  it('uses the legacy v1 ID for an active key without rotation settings', () => {
    expect(pluginEncryptionKeyringFromEnv(env())).toEqual({
      active: { id: 'v1', secret: activeSecret },
    });
  });

  it('reads an active and previous key together for rotation', () => {
    const ring = pluginEncryptionKeyringFromEnv(
      env({
        PLUGIN_ENCRYPTION_ACTIVE_KEY_ID: 'v2',
        PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1',
        PLUGIN_ENCRYPTION_KEY_PREVIOUS: previousSecret,
      })
    );

    expect(ring).toEqual({
      active: { id: 'v2', secret: activeSecret },
      previous: { id: 'v1', secret: previousSecret },
    });
    expect(pluginEncryptionSecretFor(ring, 'v2')).toBe(activeSecret);
    expect(pluginEncryptionSecretFor(ring, 'v1')).toBe(previousSecret);
    expect(() => pluginEncryptionSecretFor(ring, 'v0')).toThrow(
      'plugin_encryption_key_unavailable'
    );
  });

  it.each([
    { PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID: 'v1' },
    { PLUGIN_ENCRYPTION_KEY_PREVIOUS: previousSecret },
  ])('rejects a partial previous-key configuration: %o', (overrides) => {
    expect(() => pluginEncryptionKeyringFromEnv(env(overrides))).toThrow(
      'plugin_encryption_keyring_invalid'
    );
  });

  it.each([
    ['uppercase active ID', { active: { id: 'V2', secret: activeSecret } }],
    ['pathlike active ID', { active: { id: '../v2', secret: activeSecret } }],
    ['empty active ID', { active: { id: '', secret: activeSecret } }],
    ['long active ID', { active: { id: 'a'.repeat(65), secret: activeSecret } }],
    ['short active secret', { active: { id: 'v2', secret: 'a'.repeat(31) } }],
    [
      'matching previous ID',
      {
        active: { id: 'v2', secret: activeSecret },
        previous: { id: 'v2', secret: previousSecret },
      },
    ],
    [
      'invalid previous ID',
      {
        active: { id: 'v2', secret: activeSecret },
        previous: { id: 'V1', secret: previousSecret },
      },
    ],
    [
      'short previous secret',
      {
        active: { id: 'v2', secret: activeSecret },
        previous: { id: 'v1', secret: 'b'.repeat(31) },
      },
    ],
  ] as const)('rejects %s', (_reason, ring) => {
    expect(() => validatePluginEncryptionKeyring(ring as PluginEncryptionKeyring)).toThrow(
      'plugin_encryption_keyring_invalid'
    );
  });

  it('validates the ring again before returning a secret', () => {
    const ring = {
      active: { id: 'v2', secret: activeSecret },
      previous: { id: 'v2', secret: previousSecret },
    };
    expect(() => pluginEncryptionSecretFor(ring, 'v2')).toThrow(
      'plugin_encryption_keyring_invalid'
    );
  });
});
