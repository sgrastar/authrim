import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  assertPhase0ResponseLossAdoption,
  assertPhase0RollbackReflected,
  assertPhase0SmokeResult,
  buildPhase0OperatorTokens,
  buildWorkersDevUrl,
  buildPhase0CallerSource,
  buildPhase0SpikeNames,
  buildPhase0TargetSource,
  extractWorkersDevUrl,
  loadPhase0SpikeTokens,
  parsePhase0SpikeArgs,
  runPhase0Spike,
} from './phase0-live-spike.js';

function deployment(input: { id: string; createdOn: string; versionId: string }): {
  id: string;
  created_on: string;
  source: string;
  strategy: 'percentage';
  versions: Array<{ percentage: number; version_id: string }>;
} {
  return {
    id: input.id,
    created_on: input.createdOn,
    source: 'api',
    strategy: 'percentage',
    versions: [{ percentage: 100, version_id: input.versionId }],
  };
}

describe('Phase 0 live spike safety', () => {
  it('is dry-run by default and permits only the disposable test environment', () => {
    expect(parsePhase0SpikeArgs(['--env', 'test'])).toMatchObject({
      env: 'test',
      execute: false,
      credentialMode: 'split-token',
    });
    expect(parsePhase0SpikeArgs(['--env', 'test', '--operator-oauth'])).toMatchObject({
      env: 'test',
      execute: false,
      credentialMode: 'operator-oauth',
    });
    expect(() => parsePhase0SpikeArgs(['--env', 'conformance', '--execute'])).toThrow(
      'phase0_spike_test_environment_required'
    );
    expect(() => parsePhase0SpikeArgs(['--env', 'production', '--execute'])).toThrow(
      'phase0_spike_test_environment_required'
    );
  });

  it('rejects malformed account identifiers and unknown arguments', () => {
    expect(() => parsePhase0SpikeArgs(['--env', 'test', '--account-id', '../../account'])).toThrow(
      'invalid_cloudflare_account_id'
    );
    expect(() => parsePhase0SpikeArgs(['--env', 'test', '--delete-existing'])).toThrow(
      'unknown_argument:--delete-existing'
    );
  });

  it('uses an unmistakable bounded disposable resource prefix', () => {
    const names = buildPhase0SpikeNames(
      new Date('2026-07-29T01:02:03.000Z'),
      'abcdef00-0000-0000-0000-000000000000'
    );
    expect(names.targetWorker).toBe('authrim-cp-spike-test-20260729010203-abcdef-target');
    expect(
      [names.calleeWorker, names.tailWorker, names.targetWorker, names.callerWorker].every(
        (value) => value.length <= 63
      )
    ).toBe(true);
    expect(names.callerWorker.length).toBeLessThanOrEqual(54);
    expect(Object.values(names).every((value) => value.length <= 90)).toBe(true);
  });

  it('requires distinct scoped D1 and Workers tokens', () => {
    expect(() => loadPhase0SpikeTokens({})).toThrow('cloudflare_d1_api_token_required');
    expect(() =>
      loadPhase0SpikeTokens({
        CLOUDFLARE_D1_API_TOKEN: 'same-token',
        CLOUDFLARE_WORKERS_API_TOKEN: 'same-token',
      })
    ).toThrow('phase0_spike_split_d1_workers_tokens_required');
    expect(
      loadPhase0SpikeTokens({
        CLOUDFLARE_D1_API_TOKEN: 'd1-token',
        CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
      })
    ).toEqual({ d1: 'd1-token', workers: 'workers-token', kv: undefined, r2: undefined });
  });

  it('uses the ephemeral Wrangler OAuth credential for every operator resource class', () => {
    expect(buildPhase0OperatorTokens('wrangler-oauth')).toEqual({
      d1: 'wrangler-oauth',
      workers: 'wrangler-oauth',
      kv: 'wrangler-oauth',
      r2: 'wrangler-oauth',
    });
    expect(() => buildPhase0OperatorTokens('  ')).toThrow('wrangler_oauth_token_required');
  });

  it('uses named Service Binding RPC for a 30-second Ed25519 JWS runtime proof', async () => {
    const target = buildPhase0TargetSource();
    const caller = buildPhase0CallerSource();
    expect(target).toContain("from 'cloudflare:workers'");
    expect(target).toContain('class Phase0ControlRpc extends WorkerEntrypoint');
    expect(target).toContain("generateKey({ name: 'Ed25519' }");
    expect(target).toContain("sign({ name: 'Ed25519' }");
    expect(target).toContain("verify(\n    { name: 'Ed25519' }");
    expect(target).toContain("typ: 'authrim-phase0-smoke+jws'");
    expect(target).toContain('exp: now + 30');
    expect(caller).toContain('env.TARGET.phase0Smoke()');
    expect(caller).not.toContain('env.TARGET.fetch');
    await expect(transform(target, { loader: 'js', format: 'esm' })).resolves.toMatchObject({
      code: expect.stringContaining('Phase0ControlRpc'),
    });
    await expect(transform(caller, { loader: 'js', format: 'esm' })).resolves.toBeDefined();
  });

  it('extracts an ANSI-decorated workers.dev deployment URL', () => {
    expect(
      extractWorkersDevUrl(
        '\u001b[32mDeployed\u001b[0m https://authrim-cp-spike.example.workers.dev\u001b[0m'
      )
    ).toBe('https://authrim-cp-spike.example.workers.dev');
    expect(extractWorkersDevUrl('Worker deployed without a public route')).toBeUndefined();
    expect(buildWorkersDevUrl('phase0-caller', 'example')).toBe(
      'https://phase0-caller.example.workers.dev'
    );
    expect(() => buildWorkersDevUrl('../caller', 'example')).toThrow(
      'invalid_workers_dev_script_name'
    );
    expect(() => buildWorkersDevUrl('phase0-caller', '.example')).toThrow(
      'invalid_workers_dev_subdomain'
    );
  });

  it('fails the live run when RPC, JWS, or an expected binding smoke is false', () => {
    const passing = {
      ok: true,
      rpc: true,
      jws: true,
      marker: true,
      secret: true,
      service: true,
      durableObject: true,
      baselineD1: true,
      appendedD1: true,
      kv: null,
      r2: null,
      workerLoader: null,
    };
    expect(() =>
      assertPhase0SmokeResult(passing, {
        appendedD1: true,
        kv: false,
        r2: false,
        workerLoader: false,
      })
    ).not.toThrow();
    expect(() =>
      assertPhase0SmokeResult(
        { ...passing, jws: false },
        { appendedD1: true, kv: false, r2: false, workerLoader: false }
      )
    ).toThrow('phase0_runtime_smoke_invariant_failed');
    expect(() =>
      assertPhase0SmokeResult(passing, {
        appendedD1: true,
        kv: true,
        r2: false,
        workerLoader: false,
      })
    ).toThrow('phase0_runtime_smoke_invariant_failed');
  });

  it('adopts exactly one reflected settings deployment after response loss', () => {
    const source = deployment({
      id: 'deployment-source',
      createdOn: '2026-08-01T00:00:00.000Z',
      versionId: 'version-source',
    });
    const patched = deployment({
      id: 'deployment-patched',
      createdOn: '2026-08-01T00:00:01.000Z',
      versionId: 'version-patched',
    });
    const beforeSettings = {
      bindings: [{ name: 'BASE', type: 'plain_text', text: 'present' }],
      compatibility_date: '2026-07-01',
    };
    const desiredBinding = { name: 'SPIKE_APPENDED_DB', type: 'd1', id: 'database-appended' };
    expect(
      assertPhase0ResponseLossAdoption({
        deploymentsBefore: [source],
        deploymentsAfter: [patched, source],
        sourceVersionId: 'version-source',
        beforeSettings,
        reflectedSettings: {
          ...beforeSettings,
          bindings: [...beforeSettings.bindings, desiredBinding],
        },
        desiredBinding,
      })
    ).toEqual({ deploymentId: 'deployment-patched', versionId: 'version-patched' });
    expect(() =>
      assertPhase0ResponseLossAdoption({
        deploymentsBefore: [source],
        deploymentsAfter: [
          deployment({
            id: 'deployment-concurrent',
            createdOn: '2026-08-01T00:00:02.000Z',
            versionId: 'version-concurrent',
          }),
          patched,
          source,
        ],
        sourceVersionId: 'version-source',
        beforeSettings,
        reflectedSettings: {
          ...beforeSettings,
          bindings: [...beforeSettings.bindings, desiredBinding],
        },
        desiredBinding,
      })
    ).toThrow('phase0_response_loss_adoption_deployment_mismatch');
  });

  it('requires an exact settings rollback deployment with preserved settings', () => {
    const source = deployment({
      id: 'deployment-source',
      createdOn: '2026-08-01T00:00:00.000Z',
      versionId: 'version-source',
    });
    const patched = deployment({
      id: 'deployment-patched',
      createdOn: '2026-08-01T00:00:01.000Z',
      versionId: 'version-patched',
    });
    const restored = deployment({
      id: 'deployment-restored',
      createdOn: '2026-08-01T00:00:02.000Z',
      versionId: 'version-restored-settings',
    });
    const beforeSettings = {
      bindings: [{ name: 'BASE', type: 'plain_text', text: 'present' }],
      compatibility_date: '2026-07-01',
    };
    expect(
      assertPhase0RollbackReflected({
        deploymentsBeforeRollback: [patched, source],
        deploymentsAfterRollback: [restored, patched, source],
        sourceVersionId: 'version-source',
        mode: 'settings-patch',
        beforeSettings,
        reflectedSettings: beforeSettings,
      })
    ).toEqual({
      deploymentId: 'deployment-restored',
      versionId: 'version-restored-settings',
    });
    expect(() =>
      assertPhase0RollbackReflected({
        deploymentsBeforeRollback: [patched, source],
        deploymentsAfterRollback: [restored, patched, source],
        sourceVersionId: 'version-source',
        mode: 'settings-patch',
        beforeSettings,
        reflectedSettings: {
          ...beforeSettings,
          bindings: [...beforeSettings.bindings, { name: 'LEAKED', type: 'plain_text' }],
        },
      })
    ).toThrow('phase0_rollback_settings_mismatch');
  });

  it('writes redacted dry-run evidence without requiring Cloudflare credentials', async () => {
    const outputDir = resolve(tmpdir(), `authrim-phase0-test-${crypto.randomUUID()}`);
    try {
      const result = await runPhase0Spike(
        {
          env: 'test',
          execute: false,
          outputDir,
          credentialMode: 'split-token',
        },
        {}
      );
      const persisted = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
        mode: string;
        executorMode: string;
        conclusion: Record<string, unknown>;
      };
      expect(persisted.mode).toBe('dry-run');
      expect(persisted.executorMode).toBe('split-token');
      expect(persisted.conclusion).toEqual({ executed: false, cleanupRequired: false });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
