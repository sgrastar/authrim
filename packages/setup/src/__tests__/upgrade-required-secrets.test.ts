import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDistributedSecretValues,
  assertRequiredWorkerSecrets,
  findMissingRequiredWorkerSecrets,
  loadDeploySecretsFromKeys,
  lookupHmacDeployOptions,
  lookupHmacSlotsFromKeyState,
  REQUIRED_WORKER_SECRET_KINDS,
  requiredWorkerSecretNames,
  type DeployOptions,
} from '../core/deploy.js';
import { getSecretNamesForWorker } from '../core/secrets.js';

const bound = (...names: string[]) => vi.fn(async () => new Set(names));

describe('secrets a Worker cannot serve without', () => {
  it('requires the Lookup HMAC slots Control resolves with on Async', () => {
    expect(REQUIRED_WORKER_SECRET_KINDS['ar-async']).toEqual(['lookup_hmac']);
    expect(getSecretNamesForWorker('ar-async')).toEqual(
      expect.arrayContaining(['LOOKUP_HMAC_KEY_SLOT_A', 'LOOKUP_HMAC_KEY_SLOT_B'])
    );
    expect(requiredWorkerSecretNames('ar-async', ['B'])).toEqual({
      all: ['LOOKUP_HMAC_KEY_SLOT_B'],
      anyOf: [],
    });
    expect(requiredWorkerSecretNames('ar-async', ['B', 'A'])).toEqual({
      all: ['LOOKUP_HMAC_KEY_SLOT_B', 'LOOKUP_HMAC_KEY_SLOT_A'],
      anyOf: [],
    });
    expect(requiredWorkerSecretNames('ar-async', undefined)).toEqual({
      all: [],
      anyOf: [['LOOKUP_HMAC_KEY_SLOT_A', 'LOOKUP_HMAC_KEY_SLOT_B']],
    });
    expect(requiredWorkerSecretNames('ar-discovery', ['A'])).toEqual({ all: [], anyOf: [] });
  });

  it("reads the slots and fingerprints from Control's published key state", () => {
    expect(lookupHmacSlotsFromKeyState(undefined)).toBeUndefined();
    expect(lookupHmacSlotsFromKeyState({ activeSlot: 'B' })).toEqual(['B']);
    expect(lookupHmacDeployOptions(undefined)).toEqual({});
    expect(
      lookupHmacDeployOptions({
        activeSlot: 'B',
        activeFingerprint: 'fb',
        previousSlot: 'A',
        previousFingerprint: 'fa',
      })
    ).toEqual({ lookupHmacSlots: ['B', 'A'], lookupHmacFingerprints: { B: 'fb', A: 'fa' } });
  });

  it('refuses an existing Worker that holds only the slot Control is not using', async () => {
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: ['ar-async'], lookupHmacSlots: ['B'] },
        ['ar-async'],
        bound('LOOKUP_HMAC_KEY_SLOT_A')
      )
    ).resolves.toEqual([{ component: 'ar-async', secret: 'LOOKUP_HMAC_KEY_SLOT_B' }]);
  });

  it('accepts an existing Worker that holds the slot Control uses, whichever it is', async () => {
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: ['ar-async'], lookupHmacSlots: ['B'] },
        ['ar-async'],
        bound('LOOKUP_HMAC_KEY_SLOT_B')
      )
    ).resolves.toEqual([]);
  });

  it('requires both slots during a rotation', async () => {
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: ['ar-async'], lookupHmacSlots: ['B', 'A'] },
        ['ar-async'],
        bound('LOOKUP_HMAC_KEY_SLOT_B')
      )
    ).resolves.toEqual([{ component: 'ar-async', secret: 'LOOKUP_HMAC_KEY_SLOT_A' }]);
  });

  it('distributes from the keys directory without asking the Worker', async () => {
    const list = bound();

    await expect(
      findMissingRequiredWorkerSecrets(
        {
          secrets: { LOOKUP_HMAC_KEY_SLOT_A: 'key-a' },
          existingComponents: ['ar-async'],
          lookupHmacSlots: ['A'],
        },
        ['ar-async'],
        list
      )
    ).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses a new Worker that does not receive the secret now (it can hold none yet)', async () => {
    const list = bound('LOOKUP_HMAC_KEY_SLOT_A');

    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: [], lookupHmacSlots: ['A'] },
        ['ar-async'],
        list
      )
    ).resolves.toEqual([{ component: 'ar-async', secret: 'LOOKUP_HMAC_KEY_SLOT_A' }]);
    expect(list).not.toHaveBeenCalled();
  });

  it('accepts either slot only for a Worker deployed before Control exists', async () => {
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: { LOOKUP_HMAC_KEY_SLOT_B: 'key-b' }, existingComponents: [] },
        ['ar-async'],
        bound()
      )
    ).resolves.toEqual([]);
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: [] },
        ['ar-async'],
        bound()
      )
    ).resolves.toEqual([
      { component: 'ar-async', secret: 'LOOKUP_HMAC_KEY_SLOT_A|LOOKUP_HMAC_KEY_SLOT_B' },
    ]);
  });

  it("stops an existing Worker's deploy when Control's key state is unknown", async () => {
    await expect(
      findMissingRequiredWorkerSecrets(
        { secrets: {}, existingComponents: ['ar-async'] },
        ['ar-async'],
        bound('LOOKUP_HMAC_KEY_SLOT_A', 'LOOKUP_HMAC_KEY_SLOT_B')
      )
    ).resolves.toEqual([{ component: 'ar-async', secret: 'lookup_hmac_slots_unknown' }]);
  });

  it('stops a deploy (skip-secrets distributes nothing) before anything is deployed', async () => {
    const options: DeployOptions = {
      env: 'test',
      rootDir: '/nonexistent',
      secrets: {},
      existingComponents: ['ar-async'],
      lookupHmacSlots: ['A'],
      listWorkerSecretNames: bound(),
    };

    await expect(assertRequiredWorkerSecrets(options, ['ar-async'])).rejects.toThrow(
      'required_worker_secrets_missing:ar-async.LOOKUP_HMAC_KEY_SLOT_A'
    );
  });

  describe('distributed key values', () => {
    const key = `${'k'.repeat(43)}=`;
    const fingerprint = createHash('sha256').update(key).digest('hex');

    it('refuses a blank value, which would replace a working secret with nothing', () => {
      expect(() =>
        assertDistributedSecretValues({ secrets: { LOOKUP_HMAC_KEY_SLOT_B: ' \n' } }, ['ar-async'])
      ).toThrow('deploy_secret_value_blank:LOOKUP_HMAC_KEY_SLOT_B');
    });

    it('refuses a Lookup HMAC key that is not the one Control uses for the slot', () => {
      expect(() =>
        assertDistributedSecretValues(
          {
            secrets: { LOOKUP_HMAC_KEY_SLOT_B: `${'z'.repeat(43)}=` },
            lookupHmacFingerprints: { B: fingerprint },
          },
          ['ar-async']
        )
      ).toThrow('deploy_secret_value_mismatch:LOOKUP_HMAC_KEY_SLOT_B');
      expect(() =>
        assertDistributedSecretValues(
          {
            secrets: { LOOKUP_HMAC_KEY_SLOT_B: 'short' },
            lookupHmacFingerprints: { B: fingerprint },
          },
          ['ar-async']
        )
      ).toThrow('deploy_secret_value_invalid:LOOKUP_HMAC_KEY_SLOT_B');
    });

    it('accepts the key Control uses for the slot', () => {
      expect(() =>
        assertDistributedSecretValues(
          { secrets: { LOOKUP_HMAC_KEY_SLOT_B: key }, lookupHmacFingerprints: { B: fingerprint } },
          ['ar-async']
        )
      ).not.toThrow();
    });

    it('hashes the value exactly as distributed: a key with a trailing newline would break the runtime', () => {
      // The runtime hashes the secret as the Worker holds it, newline included, so a value that
      // only matches Control's fingerprint once trimmed must not be distributed as is.
      expect(() =>
        assertDistributedSecretValues(
          {
            secrets: { LOOKUP_HMAC_KEY_SLOT_B: `${key}\n` },
            lookupHmacFingerprints: { B: fingerprint },
          },
          ['ar-async']
        )
      ).toThrow('deploy_secret_value_mismatch:LOOKUP_HMAC_KEY_SLOT_B');
    });

    it('distributes a key file that ends in a newline without it, matching Control and the runtime', async () => {
      const keysDir = await mkdtemp(join(tmpdir(), 'authrim-newline-key-'));
      await writeFile(join(keysDir, 'lookup_hmac_key_slot_b.txt'), `  ${key}\r\n`);
      await writeFile(join(keysDir, 'object_encryption_root_key.txt'), 'root-key\n');

      const secrets = await loadDeploySecretsFromKeys(keysDir, ['ar-async']);

      expect(secrets.LOOKUP_HMAC_KEY_SLOT_B).toBe(key);
      expect(() =>
        assertDistributedSecretValues({ secrets, lookupHmacFingerprints: { B: fingerprint } }, [
          'ar-async',
        ])
      ).not.toThrow();
      // Other secrets are distributed exactly as stored.
      expect(secrets.OBJECT_ENCRYPTION_ROOT_KEY).toBe('root-key\n');
    });

    it('refuses an explicit but blank key file when loading the keys directory', async () => {
      const keysDir = await mkdtemp(join(tmpdir(), 'authrim-blank-key-'));
      await writeFile(join(keysDir, 'lookup_hmac_key_slot_b.txt'), '  \n');

      await expect(loadDeploySecretsFromKeys(keysDir, ['ar-async'])).rejects.toThrow(
        'deploy_secret_file_blank:lookup_hmac_key_slot_b.txt'
      );
    });
  });

  it('runs the check in the shared deploy path and before the first update deploy', async () => {
    const deploy = await readFile(new URL('../core/deploy.ts', import.meta.url), 'utf-8');
    const deployAll = deploy.slice(deploy.indexOf('export async function deployAll('));
    const sharedCheck = deployAll.indexOf('await assertRequiredWorkerSecrets(options, components)');
    expect(sharedCheck).toBeGreaterThan(0);
    expect(sharedCheck).toBeLessThan(
      deployAll.indexOf('resolveDeploymentStrategy(options, components)')
    );

    const update = await readFile(new URL('../cli/commands/update.ts', import.meta.url), 'utf-8');
    const check = update.indexOf(
      'await assertRequiredWorkerSecrets(deployOptions, componentsToUpdate)'
    );
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(update.indexOf('await deployAll('));
    expect(update).toContain('...lookupHmacDeployOptions(workingLock.controlKeyState?.lookupHmac)');

    const deployCommand = await readFile(
      new URL('../cli/commands/deploy.ts', import.meta.url),
      'utf-8'
    );
    expect(deployCommand).toContain(
      '...lookupHmacDeployOptions(currentLock.controlKeyState?.lookupHmac)'
    );

    // The single-component upgrade and the Web update and component deploys read Control fresh.
    const upgrade = await readFile(new URL('../index.ts', import.meta.url), 'utf-8');
    expect(upgrade).toContain(
      'resolveDeployLookupHmacState({ lock: upgradeLock, environmentId: env })'
    );
    const web = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    expect(web.split('await resolveDeployLookupHmacState(').length - 1).toBe(2);
  });
});
