import { describe, expect, it, vi } from 'vitest';
import type { SamlDrWriterInventoryReceipt } from '../saml-dr-writer-contract';
import { hasTenantBackupMutationCoverage } from '../covered-mutation';
import {
  assertSamlDrWriterCoverage,
  runSamlDrCoveredFetch,
  runSamlDrCoveredOperation,
  samlDrWaitUntil,
  samlDrAll,
} from '../saml-dr-writer';

function fixture() {
  const order: string[] = [];
  const control = {
    acquireEnvironmentBackupMutationPermit: vi.fn(async () => {
      order.push('acquire');
      return { admitted: true };
    }),
    completeEnvironmentBackupMutationPermit: vi.fn(async () => {
      order.push('complete');
    }),
  };
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    TENANT_BACKUP_WRAPPING_KEY: 'key',
    SAML_DR_MUTATION_CONTROL: control,
  };
  const context = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
  return { env, context, control, order };
}

describe('opt-in SAML source writer guard', () => {
  it('preserves the environment/context and makes no Control call by default', async () => {
    const { env, context, control } = fixture();
    env.ENABLE_SAML_DR_EXPORT = 'false';
    await runSamlDrCoveredOperation(env, context, async (actual, ctx) => {
      expect(actual).toBe(env);
      expect(ctx).toBe(context);
    });
    expect(control.acquireEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
  });
  it('waits for nested deferred effects before releasing the permit', async () => {
    const { env, context, order } = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = runSamlDrCoveredOperation(env, context, async (covered, ctx) => {
      expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(true);
      ctx!.waitUntil(
        gate.then(() => {
          order.push('outer');
          ctx!.waitUntil(
            Promise.resolve().then(() => {
              order.push('inner');
            })
          );
        })
      );
      order.push('response');
      return 'ok';
    });
    await vi.waitFor(() => expect(order).toEqual(['acquire', 'response']));
    finish();
    await expect(result).resolves.toBe('ok');
    expect(order).toEqual(['acquire', 'response', 'outer', 'inner', 'complete']);
  });
  it('does not perform a write when admission is denied', async () => {
    const { env, control } = fixture();
    control.acquireEnvironmentBackupMutationPermit.mockResolvedValue({ admitted: false });
    const effect = vi.fn(async () => new Response('ok'));
    const result = await runSamlDrCoveredFetch(env, undefined, effect);
    expect(result.status).toBe(503);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(effect).not.toHaveBeenCalled();
    expect(control.completeEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
  });
  it('drains all effects and completes after a deferred failure without disclosing it', async () => {
    const { env, context, order } = fixture();
    const response = await runSamlDrCoveredFetch(env, context, async (_env, ctx) => {
      ctx!.waitUntil(Promise.reject(new Error('private-secret')));
      ctx!.waitUntil(
        Promise.resolve().then(() => {
          order.push('other-effect');
        })
      );
      return new Response('success');
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-secret');
    expect(order).toEqual(['acquire', 'other-effect', 'complete']);
  });
  it('requires admission but does not distribute the backup wrapping key to writers', async () => {
    const { env } = fixture();
    await expect(
      runSamlDrCoveredOperation(
        { ...env, TENANT_BACKUP_WRAPPING_KEY: undefined },
        undefined,
        async () => 'ok'
      )
    ).resolves.toBe('ok');
    const effect = vi.fn(async () => 'written');
    await expect(
      runSamlDrCoveredOperation({ ...env, SAML_DR_MUTATION_CONTROL: undefined }, undefined, effect)
    ).rejects.toThrow('saml_dr_writer_unavailable');
    expect(effect).not.toHaveBeenCalled();
  });
  it('shares only nested async ownership, never another simultaneous call on the same instance', async () => {
    const { env, control, context } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runSamlDrCoveredOperation(env, context, async () => {
      await runSamlDrCoveredOperation(env, undefined, async () => undefined);
      samlDrWaitUntil(context, pending);
    });
    await vi.waitFor(() =>
      expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(1)
    );
    await runSamlDrCoveredOperation(env, undefined, async () => undefined);
    expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(2);
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(2);
  });
  it.each(['parallel', 'nested'])(
    'drains %s sibling writes after an early failure',
    async (kind) => {
      const { env, control } = fixture();
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run = runSamlDrCoveredOperation(env, undefined, async () => {
        if (kind === 'parallel') return samlDrAll([Promise.reject(new Error('failed')), gate]);
        return Promise.all([
          runSamlDrCoveredOperation(env, undefined, async () => {
            throw new Error('failed');
          }),
          runSamlDrCoveredOperation(env, undefined, async () => {
            await gate;
          }),
        ]);
      });
      const assertion = expect(run).rejects.toThrow('failed');
      await vi.waitFor(() =>
        expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(1)
      );
      expect(control.completeEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
      finish();
      await assertion;
      expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(1);
    }
  );
  it('preserves caller recovery after a failed parallel write has fully settled', async () => {
    const { env, control } = fixture();
    await expect(
      runSamlDrCoveredOperation(env, undefined, async () => {
        try {
          await samlDrAll([Promise.reject(new Error('retryable'))]);
        } catch {
          /* retry below */
        }
        return samlDrAll([Promise.resolve('retried')]);
      })
    ).resolves.toEqual(['retried']);
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
  });
  it('requires a new permit for an async descendant invoked after its owning operation ended', async () => {
    const { env, control } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<void>;
    await runSamlDrCoveredOperation(env, undefined, async () => {
      late = gate.then(() => runSamlDrCoveredOperation(env, undefined, async () => undefined));
    });
    release();
    await late;
    expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(2);
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(2);
  });
  it('pins and rechecks the same authenticated Control receipt', async () => {
    const receipt: SamlDrWriterInventoryReceipt = {
      formatVersion: 1,
      accountId: 'account',
      environmentId: 'dr-test',
      tenantId: 'tenant-a',
      workers: [
        {
          workerName: 'dr-test-ar-auth',
          deploymentId: 'deployment',
          versionId: 'version',
          bindings: [],
          bindingsDigest: 'b'.repeat(64),
          component: 'ar-auth',
          contractDigest: 'c'.repeat(64),
        },
      ],
      protectedResources: ['d1:source'],
      inventoryDigest: 'a'.repeat(64),
    };
    const inspect = vi.fn(async () => receipt);
    const env = {
      ...fixture().env,
      AUTHRIM_ENVIRONMENT_NAME: 'dr-test',
      CONTROL: { inspectSamlDrWriterCoverage: inspect },
    };
    await expect(assertSamlDrWriterCoverage(env, 'tenant-a', undefined, receipt)).resolves.toEqual(
      receipt
    );
    expect(inspect).toHaveBeenCalledWith({ tenantId: 'tenant-a', expectedReceipt: receipt });
    await expect(assertSamlDrWriterCoverage(env, 'tenant-b')).rejects.toThrow(
      'saml_dr_writer_inventory_unverified'
    );
    await expect(
      assertSamlDrWriterCoverage(env, 'tenant-a', undefined, {
        ...receipt,
        inventoryDigest: 'd'.repeat(64),
      })
    ).rejects.toThrow('saml_dr_writer_inventory_changed');
    const controller = new AbortController();
    controller.abort();
    inspect.mockClear();
    await expect(assertSamlDrWriterCoverage(env, 'tenant-a', controller.signal)).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });
  it('does not mistake known request guards for complete writer coverage', async () => {
    await expect(assertSamlDrWriterCoverage(fixture().env, 'tenant-a')).rejects.toThrow(
      'saml_dr_writer_inventory_unverified'
    );
  });
});
