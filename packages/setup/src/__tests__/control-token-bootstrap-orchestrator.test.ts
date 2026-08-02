import { describe, expect, it } from 'vitest';
import { CloudflareTokenBootstrapError } from '../core/cloudflare-control-token-bootstrap.js';
import {
  classifyControlTokenBootstrapFailure,
  findMissingControlTokenResourceClasses,
  hasReadyControlTokenBootstrap,
  resolveControlTokenResourceClasses,
} from '../core/control-token-bootstrap-orchestrator.js';
import { createDefaultConfig } from '../core/config.js';

describe('Control token resource classes', () => {
  it('requests only the baseline split tokens without Dynamic Workers', () => {
    expect(resolveControlTokenResourceClasses(createDefaultConfig('test'))).toEqual([
      'd1',
      'workers',
    ]);
  });

  it('recognizes an already-ready authority only when every required secret name exists', async () => {
    const query = async () => [
      {
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'user',
        provisioning_capability_state: 'ready',
        provisioning_capability_checked_at: 100,
      },
    ];
    await expect(
      hasReadyControlTokenBootstrap({
        environmentId: 'test',
        controlDatabaseName: 'control',
        resourceClasses: ['d1', 'workers'],
        secretSink: {
          listNames: async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'],
          has: async () => false,
        },
        query,
      })
    ).resolves.toBe(true);
  });

  it('requests separate KV and R2 tokens when Dynamic Workers are enabled', () => {
    const config = createDefaultConfig('test');
    config.features.pluginDynamicWorkers.enabled = true;

    expect(resolveControlTokenResourceClasses(config)).toEqual(['d1', 'workers', 'kv', 'r2']);
  });

  it('reports only missing resource classes without reading secret values', async () => {
    const checkedNames: string[] = [];
    const missing = await findMissingControlTokenResourceClasses({
      resourceClasses: ['d1', 'workers', 'kv', 'r2'],
      secretSink: {
        has: async (secretName) => {
          checkedNames.push(secretName);
          return (
            secretName === 'CLOUDFLARE_D1_API_TOKEN' ||
            secretName === 'CLOUDFLARE_WORKERS_API_TOKEN'
          );
        },
      },
    });

    expect(missing).toEqual(['kv', 'r2']);
    expect(checkedNames).toEqual([
      'CLOUDFLARE_D1_API_TOKEN',
      'CLOUDFLARE_WORKERS_API_TOKEN',
      'CLOUDFLARE_KV_API_TOKEN',
      'CLOUDFLARE_R2_API_TOKEN',
    ]);
  });

  it('uses one secret-name listing when the sink supports it', async () => {
    let listCount = 0;
    const missing = await findMissingControlTokenResourceClasses({
      resourceClasses: ['d1', 'workers', 'kv', 'r2'],
      secretSink: {
        listNames: async () => {
          listCount += 1;
          return ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'];
        },
        has: async () => {
          throw new Error('per-secret lookup should not run');
        },
      },
    });

    expect(missing).toEqual(['kv', 'r2']);
    expect(listCount).toBe(1);
  });
});

describe('Control token bootstrap failure authority', () => {
  it('returns to tokenless pending when cleanup is confirmed', () => {
    expect(
      classifyControlTokenBootstrapFailure(
        new CloudflareTokenBootstrapError('cloudflare_control_secret_list_invalid', false),
        'user'
      )
    ).toEqual({ tokenOwnership: 'none', capabilityState: 'pending' });
  });

  it('retains ownership and blocks when cleanup is not confirmed', () => {
    expect(
      classifyControlTokenBootstrapFailure(
        new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true),
        'account'
      )
    ).toEqual({ tokenOwnership: 'account', capabilityState: 'blocked' });
  });

  it('does not claim token ownership for failures before child creation', () => {
    expect(classifyControlTokenBootstrapFailure(new Error('prepare_failed'), 'account')).toEqual({
      tokenOwnership: 'none',
      capabilityState: 'pending',
    });
  });
});
