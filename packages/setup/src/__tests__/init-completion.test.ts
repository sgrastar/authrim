import { createArchiveTestConfig, selectScheduledArchive } from './fixtures/log-archive.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSetupCompletionNextSteps,
  resolveInitialLogStorageFeatures,
} from '../cli/commands/init.js';
import { initI18n } from '../i18n/index.js';

describe('normal wizard archive feature finalization', () => {
  for (const mode of ['pipeline', 'scheduled'] as const)
    it(`keeps R2 selected for ${mode} after an earlier disabled answer`, () => {
      const config = selectScheduledArchive(createArchiveTestConfig('test'));
      config.logging!.archive.mode = mode;
      const features = resolveInitialLogStorageFeatures(config, { r2: false, queue: false });
      expect(features.r2.enabled).toBe(true);
      expect(features.queue.enabled).toBe(mode === 'pipeline');
      config.features = { ...config.features, ...features };
      expect(config.features.r2.enabled).toBe(true);
    });
});

describe('setup completion next steps', () => {
  beforeEach(async () => {
    await initI18n('en');
  });

  it('directs Automatic provisioning OFF through Wrangler OAuth without requesting API tokens', () => {
    const lines = buildSetupCompletionNextSteps({
      env: 'test',
      automaticProvisioning: false,
      commandPrefix: 'pnpm run setup',
    });

    expect(lines.join('\n')).toContain('Wrangler OAuth');
    expect(lines.join('\n')).toContain('Automatic provisioning is OFF');
    expect(lines.join('\n')).toContain('pnpm run setup deploy --env test');
    expect(lines.join('\n')).not.toContain('CLOUDFLARE_D1_API_TOKEN');
    expect(lines.join('\n')).not.toContain('bootstrap token');
  });

  it('directs Automatic provisioning ON through one-time bootstrap handoff', () => {
    const lines = buildSetupCompletionNextSteps({
      env: 'test',
      automaticProvisioning: true,
      commandPrefix: 'pnpm run setup',
    });

    expect(lines.join('\n')).toContain('one-time Cloudflare bootstrap token');
    expect(lines.join('\n')).toContain('split child tokens directly on Control');
    expect(lines.join('\n')).toContain('revokes the bootstrap token');
    expect(lines.join('\n')).not.toContain('CLOUDFLARE_D1_API_TOKEN');
    expect(lines.join('\n')).not.toContain('CLOUDFLARE_WORKERS_API_TOKEN');
  });

  it('renders the next steps in the selected locale', async () => {
    await initI18n('ja');

    const lines = buildSetupCompletionNextSteps({
      env: 'test',
      automaticProvisioning: false,
      commandPrefix: 'pnpm run setup',
    });

    expect(lines.join('\n')).toContain('現在のWrangler OAuthログイン');
    expect(lines.join('\n')).toContain('自動プロビジョニングはオフ');
    expect(lines.join('\n')).not.toContain('Automatic provisioning is off');
  });
});
