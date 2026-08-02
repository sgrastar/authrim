import { describe, expect, it } from 'vitest';
import { buildSetupCompletionNextSteps } from '../cli/commands/init.js';

describe('setup completion next steps', () => {
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
});
