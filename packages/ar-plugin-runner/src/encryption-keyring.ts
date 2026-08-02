import type { PluginRunnerEnv } from './types';

const SAFE_KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface PluginEncryptionKeyring {
  active: { id: string; secret: string };
  previous?: { id: string; secret: string };
}

export function validatePluginEncryptionKeyring(
  keyring: PluginEncryptionKeyring
): PluginEncryptionKeyring {
  if (
    !SAFE_KEY_ID.test(keyring.active.id) ||
    keyring.active.secret.length < 32 ||
    (keyring.previous !== undefined &&
      (!SAFE_KEY_ID.test(keyring.previous.id) ||
        keyring.previous.secret.length < 32 ||
        keyring.previous.id === keyring.active.id))
  ) {
    throw new Error('plugin_encryption_keyring_invalid');
  }
  return keyring;
}

export function pluginEncryptionKeyringFromEnv(env: PluginRunnerEnv): PluginEncryptionKeyring {
  const previousId = env.PLUGIN_ENCRYPTION_PREVIOUS_KEY_ID;
  const previousSecret = env.PLUGIN_ENCRYPTION_KEY_PREVIOUS;
  if ((previousId === undefined) !== (previousSecret === undefined)) {
    throw new Error('plugin_encryption_keyring_invalid');
  }
  return validatePluginEncryptionKeyring({
    active: {
      id: env.PLUGIN_ENCRYPTION_ACTIVE_KEY_ID ?? 'v1',
      secret: env.PLUGIN_ENCRYPTION_KEY,
    },
    ...(previousId && previousSecret
      ? { previous: { id: previousId, secret: previousSecret } }
      : {}),
  });
}

export function pluginEncryptionSecretFor(keyring: PluginEncryptionKeyring, keyId: string): string {
  const validated = validatePluginEncryptionKeyring(keyring);
  if (validated.active.id === keyId) return validated.active.secret;
  if (validated.previous?.id === keyId) return validated.previous.secret;
  throw new Error('plugin_encryption_key_unavailable');
}
