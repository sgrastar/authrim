import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployWithRetryPath = fileURLToPath(
  new URL('../../../../scripts/deploy-with-retry.sh', import.meta.url)
);
const deployApiPath = fileURLToPath(new URL('../../../../scripts/deploy-api.ts', import.meta.url));
const controlWranglerJsoncPath = fileURLToPath(
  new URL('../../../ar-control/wrangler.jsonc', import.meta.url)
);

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

  it('keeps the test endpoint override test-only and management-only', () => {
    const apiSource = readFileSync(deployApiPath, 'utf-8');

    expect(apiSource).toContain("env !== 'test'");
    expect(apiSource).toContain("component !== 'ar-management'");
    expect(apiSource).toContain("ENABLE_TEST_ENDPOINTS: options.testEndpoints === 'enabled'");
    expect(apiSource).toContain('--test-endpoints must be enabled or disabled');
  });

  it('refreshes Control-generated Worker bindings before API deployment', () => {
    const apiSource = readFileSync(deployApiPath, 'utf-8');
    const leaseHookIndex = apiSource.indexOf('beforeWorkerMutations: async () => {');
    const refreshIndex = apiSource.indexOf('await refreshWorkerDeploymentArtifacts({');
    const deploymentIndex = apiSource.indexOf('summary = await deployAll(');

    expect(leaseHookIndex).toBeGreaterThan(-1);
    expect(refreshIndex).toBeGreaterThan(leaseHookIndex);
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(deploymentIndex).toBeGreaterThan(refreshIndex);
    expect(apiSource).toContain('updateLockWithDeployments(workingLock, summary.results)');
  });

  it('blocks unmanaged deploys through the tracked Wrangler JSONC fallback', () => {
    const controlConfig = readFileSync(controlWranglerJsoncPath, 'utf8');

    expect(controlConfig).toContain('node ../../scripts/guard-managed-worker-deploy.mjs');
  });
});
