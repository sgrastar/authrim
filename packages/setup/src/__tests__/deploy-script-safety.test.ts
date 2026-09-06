import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployWithRetryPath = fileURLToPath(
  new URL('../../../../scripts/deploy-with-retry.sh', import.meta.url)
);
const deployApiPath = fileURLToPath(new URL('../../../../scripts/deploy-api.ts', import.meta.url));
const deployUiPath = fileURLToPath(new URL('../../../../scripts/deploy-ui.ts', import.meta.url));
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
    expect(apiSource).toContain('updateLockWithDeployments(latestLockState.lock, summary.results)');
  });

  it('rejects a canonical config copied under another environment name', () => {
    const apiSource = readFileSync(deployApiPath, 'utf-8');
    const uiSource = readFileSync(deployUiPath, 'utf-8');

    expect(apiSource).toContain('config.environment.prefix !== env');
    expect(apiSource).toContain('deployment_config_environment_mismatch:${env}');
    expect(uiSource).toContain('config.environment.prefix !== env');
    expect(uiSource).toContain('deployment_config_environment_mismatch:${env}');
  });

  it('advances script locks only after exact Worker identity and readiness checks', () => {
    const apiSource = readFileSync(deployApiPath, 'utf-8');
    const uiSource = readFileSync(deployUiPath, 'utf-8');

    const apiIdentityIndex = apiSource.indexOf('!result.cloudflareScriptTag');
    const apiVisibilityIndex = apiSource.indexOf('await waitForWorkerDeploymentsReady({');
    const apiSaveIndex = apiSource.indexOf(
      'updateLockWithDeployments(latestLockState.lock, summary.results)'
    );
    expect(apiIdentityIndex).toBeGreaterThan(-1);
    expect(apiVisibilityIndex).toBeGreaterThan(apiIdentityIndex);
    expect(apiSaveIndex).toBeGreaterThan(apiVisibilityIndex);

    const uiIdentityIndex = uiSource.indexOf('!result.cloudflareScriptTag');
    const uiVisibilityIndex = uiSource.indexOf('await waitForWorkerDeploymentsReady({');
    const uiSaveIndex = uiSource.indexOf('await saveLockFile(');
    expect(uiIdentityIndex).toBeGreaterThan(-1);
    expect(uiVisibilityIndex).toBeGreaterThan(uiIdentityIndex);
    expect(uiSaveIndex).toBeGreaterThan(uiVisibilityIndex);
    expect(uiSource).toContain('cloudflareVersionId: result.cloudflareVersionId');
    expect(uiSource).toContain('cloudflareScriptTag: result.cloudflareScriptTag');
  });

  it('blocks unmanaged deploys through the tracked Wrangler JSONC fallback', () => {
    const controlConfig = readFileSync(controlWranglerJsoncPath, 'utf8');

    expect(controlConfig).toContain('node ../../scripts/guard-managed-worker-deploy.mjs');
  });
});
