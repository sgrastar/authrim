import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getAutomaticWranglerSyncAction,
  getDeployKeysDirHint,
  resolveApiDeployComponents,
  resolveDeployFailureAction,
  resolveDeployOperationKind,
  requiresInitialControlTokenBootstrap,
  resolveTestEndpointVarOverrides,
  resolveTestPlacementOverrides,
} from '../cli/commands/deploy';

describe('deploy prompt policy', () => {
  it('treats an existing-environment deploy as a Worker redeploy by default', () => {
    expect(resolveDeployOperationKind({ isInitialDeployment: false })).toBe('worker_redeploy');
    expect(
      resolveDeployOperationKind({
        isInitialDeployment: false,
        operationKind: 'topology_change',
      })
    ).toBe('topology_change');
    expect(
      resolveDeployOperationKind({
        isInitialDeployment: true,
        operationKind: 'topology_change',
      })
    ).toBe('initial_deploy');
  });

  it('throws only for blocking failures requested by an embedded maintenance caller', () => {
    expect(
      resolveDeployFailureAction({ blockingDeploymentFailures: false, throwOnFailure: true })
    ).toBe('continue');
    expect(resolveDeployFailureAction({ blockingDeploymentFailures: true })).toBe('set_exit_code');
    expect(
      resolveDeployFailureAction({ blockingDeploymentFailures: true, throwOnFailure: true })
    ).toBe('throw');
  });

  it('prompts for the bootstrap token only after Worker deployment readiness', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const readinessIndex = source.indexOf(
      'const workerDeploymentResult = await waitForWorkerDeploymentsReady({'
    );
    const promptIndex = source.indexOf('await promptForControlTokenBootstrap({');

    expect(readinessIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(readinessIndex);
  });

  it('selects a file-backed bootstrap before rejecting a non-interactive terminal', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const plannerIndex = source.indexOf(
      'const planMissingControlProvisioningCredentials = async (): Promise<void> => {'
    );
    const tokenFileIndex = source.indexOf(
      'if (options.cloudflareBootstrapTokenFile) {',
      plannerIndex
    );
    const terminalGuardIndex = source.indexOf(
      'if (!process.stdin.isTTY || !process.stdout.isTTY) {',
      plannerIndex
    );

    expect(plannerIndex).toBeGreaterThan(-1);
    expect(tokenFileIndex).toBeGreaterThan(plannerIndex);
    expect(terminalGuardIndex).toBeGreaterThan(tokenFileIndex);
  });

  it('detects bootstrap token ownership after receiving the secret', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const tokenInputIndex = source.indexOf('bootstrapToken = options.cloudflareBootstrapTokenFile');
    const ownershipDetectionIndex = source.indexOf(': await detectCloudflareTokenOwnership({');
    const bootstrapIndex = source.indexOf('completeControlTokenBootstrap({');

    expect(tokenInputIndex).toBeGreaterThan(-1);
    expect(ownershipDetectionIndex).toBeGreaterThan(tokenInputIndex);
    expect(bootstrapIndex).toBeGreaterThan(ownershipDetectionIndex);
    expect(source.slice(bootstrapIndex, bootstrapIndex + 500)).toContain(
      'ownership: detectedOwnership'
    );
    expect(source).toContain("bootstrapPhase !== 'none'");
    expect(source).toContain('if (!recoveringBootstrap) {');
    expect(source).toContain('...(token ? { bootstrapToken: token } : {})');
  });

  it('securely loads a pre-authority artifact only after taking the environment lock', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const lockIndex = source.indexOf("await acquireEnvironmentOperationLock(lockPath, 'deploy')");
    const artifactLoadIndex = source.indexOf(
      'loadPendingControlBootstrap({ baseDir: rootDir, environment: env })',
      lockIndex
    );
    const recoveryDecisionIndex = source.indexOf(
      'recoverWithoutBootstrapToken: true',
      artifactLoadIndex
    );
    const tokenPromptIndex = source.indexOf(
      'bootstrapToken = options.cloudflareBootstrapTokenFile',
      recoveryDecisionIndex
    );

    expect(lockIndex).toBeGreaterThan(-1);
    expect(artifactLoadIndex).toBeGreaterThan(lockIndex);
    expect(recoveryDecisionIndex).toBeGreaterThan(artifactLoadIndex);
    expect(tokenPromptIndex).toBeGreaterThan(recoveryDecisionIndex);
  });

  it('surfaces a retained bootstrap token as retryable instead of requesting cleanup', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const retainedCheck = source.indexOf('error.bootstrapRetainedForRetry');
    const retryMessage = source.indexOf(
      'The staged bootstrap transaction remains available for an automatic retry'
    );
    const manualCleanupMessage = source.indexOf('Cloudflare token cleanup could not be confirmed.');

    expect(retainedCheck).toBeGreaterThan(-1);
    expect(retryMessage).toBeGreaterThan(retainedCheck);
    expect(manualCleanupMessage).toBeGreaterThan(retryMessage);
  });

  it('re-reads ready authority and the exact active secret generation after taking the lock', () => {
    const source = readFileSync(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf8');
    const lockIndex = source.indexOf("await acquireEnvironmentOperationLock(lockPath, 'deploy')");
    const lockedReadIndex = source.indexOf(
      'const [lockedAuthority, lockedPendingArtifact] = await Promise.all([',
      lockIndex
    );
    const authorityReadIndex = source.indexOf(
      'readControlProvisioningAuthority({',
      lockedReadIndex
    );
    const lockedGenerationIndex = source.indexOf(
      'const lockedReady = await hasReadyControlTokenBootstrap({',
      authorityReadIndex
    );
    const skipIndex = source.indexOf('pendingControlTokenBootstrap = null;', lockedGenerationIndex);

    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockedReadIndex).toBeGreaterThan(lockIndex);
    expect(authorityReadIndex).toBeGreaterThan(lockedReadIndex);
    expect(lockedGenerationIndex).toBeGreaterThan(authorityReadIndex);
    expect(skipIndex).toBeGreaterThan(lockedGenerationIndex);
  });

  it('requires Control token bootstrap only for the initial automatic deployment', () => {
    const baseline = {
      dryRun: false,
      controlIncluded: true,
      automaticProvisioningEnabled: true,
    };

    expect(requiresInitialControlTokenBootstrap({ ...baseline, isInitialDeployment: true })).toBe(
      true
    );
    expect(requiresInitialControlTokenBootstrap({ ...baseline, isInitialDeployment: false })).toBe(
      false
    );
    expect(
      requiresInitialControlTokenBootstrap({
        ...baseline,
        isInitialDeployment: true,
        dryRun: true,
      })
    ).toBe(false);
    expect(
      requiresInitialControlTokenBootstrap({
        ...baseline,
        isInitialDeployment: true,
        automaticProvisioningEnabled: false,
      })
    ).toBe(false);
  });

  it('overwrites the generated target environment section in --yes mode', () => {
    expect(getAutomaticWranglerSyncAction({ yes: true })).toBe('overwrite');
  });

  it('keeps interactive choice enabled without --yes', () => {
    expect(getAutomaticWranglerSyncAction({ yes: false })).toBeNull();
    expect(getAutomaticWranglerSyncAction({})).toBeNull();
  });

  it('falls back from a stale configured key path but preserves an explicit override', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'authrim-deploy-keys-'));
    mkdirSync(join(baseDir, 'keys'));
    mkdirSync(join(baseDir, 'existing-keys'));

    expect(
      getDeployKeysDirHint({ baseDir, configuredKeysDir: './missing-legacy-keys/' })
    ).toBeUndefined();
    expect(getDeployKeysDirHint({ baseDir, configuredKeysDir: './keys/' })).toBeUndefined();
    expect(getDeployKeysDirHint({ baseDir, configuredKeysDir: './existing-keys/' })).toBe(
      './existing-keys/'
    );
    expect(
      getDeployKeysDirHint({
        baseDir,
        explicitKeysDir: './intentional-missing-path/',
        configuredKeysDir: './existing-keys/',
      })
    ).toBe('./intentional-missing-path/');
  });
});

describe('test Worker placement override', () => {
  it('allows one test API Worker to opt into or out of Smart Placement', () => {
    expect(
      resolveTestPlacementOverrides({
        environmentId: 'test',
        component: 'ar-management',
        placement: 'smart',
      })
    ).toEqual({ 'ar-management': 'smart' });
    expect(
      resolveTestPlacementOverrides({
        environmentId: 'test',
        component: 'ar-management',
        placement: 'off',
      })
    ).toEqual({ 'ar-management': 'off' });
  });

  it('rejects production, multi-component, UI, and unknown placement overrides', () => {
    expect(() =>
      resolveTestPlacementOverrides({
        environmentId: 'production',
        component: 'ar-management',
        placement: 'smart',
      })
    ).toThrow('worker_placement_override_test_environment_required');
    expect(() =>
      resolveTestPlacementOverrides({
        environmentId: 'test',
        components: ['ar-management'],
        placement: 'smart',
      })
    ).toThrow('worker_placement_override_single_component_required');
    expect(() =>
      resolveTestPlacementOverrides({
        environmentId: 'test',
        component: 'ar-admin-ui',
        placement: 'smart',
      })
    ).toThrow('worker_placement_override_component_invalid');
    expect(() =>
      resolveTestPlacementOverrides({
        environmentId: 'test',
        component: 'ar-management',
        placement: 'near-d1',
      })
    ).toThrow('worker_placement_override_mode_invalid');
  });
});

describe('test endpoint Worker override', () => {
  it('allows only one test ar-management deployment to enable or disable test endpoints', () => {
    expect(
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        component: 'ar-management',
        testEndpoints: 'enabled',
      })
    ).toEqual({ 'ar-management': { ENABLE_TEST_ENDPOINTS: 'true' } });
    expect(
      resolveTestEndpointVarOverrides({
        environmentId: 'test-ucp',
        component: 'ar-management',
        testEndpoints: 'enabled',
      })
    ).toEqual({ 'ar-management': { ENABLE_TEST_ENDPOINTS: 'true' } });
    expect(
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        component: 'ar-management',
        testEndpoints: 'disabled',
      })
    ).toEqual({ 'ar-management': { ENABLE_TEST_ENDPOINTS: 'false' } });
    expect(
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        component: 'ar-management',
      })
    ).toEqual({});
  });

  it('rejects production, multi-component, another Worker, and unknown modes', () => {
    expect(() =>
      resolveTestEndpointVarOverrides({
        environmentId: 'production',
        component: 'ar-management',
        testEndpoints: 'enabled',
      })
    ).toThrow('worker_test_endpoint_override_test_environment_required');
    expect(() =>
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        components: ['ar-management'],
        testEndpoints: 'enabled',
      })
    ).toThrow('worker_test_endpoint_override_management_component_required');
    expect(() =>
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        component: 'ar-auth',
        testEndpoints: 'enabled',
      })
    ).toThrow('worker_test_endpoint_override_management_component_required');
    expect(() =>
      resolveTestEndpointVarOverrides({
        environmentId: 'test',
        component: 'ar-management',
        testEndpoints: 'on',
      })
    ).toThrow('worker_test_endpoint_override_mode_invalid');
  });
});

describe('focused deployment components', () => {
  it('preserves an exact bounded maintenance target set', () => {
    expect(resolveApiDeployComponents({ components: ['ar-control', 'ar-management'] })).toEqual([
      'ar-control',
      'ar-management',
    ]);
  });

  it('rejects empty, duplicate, UI, and unknown internal targets', () => {
    expect(() => resolveApiDeployComponents({ components: [] })).toThrow(
      'focused_deployment_components_invalid'
    );
    expect(() => resolveApiDeployComponents({ components: ['ar-control', 'ar-control'] })).toThrow(
      'focused_deployment_components_invalid'
    );
    expect(() => resolveApiDeployComponents({ component: 'ar-admin-ui' })).toThrow(
      'focused_deployment_components_invalid'
    );
    expect(() => resolveApiDeployComponents({ component: 'unknown-worker' })).toThrow(
      'focused_deployment_components_invalid'
    );
  });
});
