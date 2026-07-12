import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployWithRetryPath = fileURLToPath(
  new URL('../../../../scripts/deploy-with-retry.sh', import.meta.url)
);
const deployApiPath = fileURLToPath(new URL('../../../../scripts/deploy-api.ts', import.meta.url));

describe('deployment script version safety', () => {
  it('finalizes shared legacy secret cleanup after the complete gradual rollout', () => {
    const shellSource = readFileSync(deployWithRetryPath, 'utf-8');
    const apiSource = readFileSync(deployApiPath, 'utf-8');

    expect(shellSource).toContain('--finalize-legacy-static-secret-cleanup');
    expect(apiSource).toContain("['ar-lib-core', 'ar-auth', 'ar-token', 'ar-management']");
    expect(apiSource).toContain('Legacy static secret cleanup finalized.');
  });

  it('does not create untracked post-deployment secret versions', () => {
    const shellSource = readFileSync(deployWithRetryPath, 'utf-8');

    expect(shellSource).not.toContain('pnpm exec wrangler secret bulk');
    expect(shellSource).not.toContain('register_versions');
    expect(shellSource).not.toContain('verify_versions_registered');
    expect(shellSource).not.toContain('admin_secret');
  });
});
