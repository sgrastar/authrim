import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule } from '@authrim/ar-lib-field-mapping/authoring';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import { TEST_CATALOG } from '@authrim/ar-lib-field-mapping/test-support';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingInput,
  MappingRuleGraph,
} from '@authrim/ar-lib-field-mapping/contract';
import { MAPPING_HASH_SECRET_REF, prepareTenantMappingHashes } from '../mapping-hash';

const sourceRef: FieldRef = { side: 'source', namespace: 'synthetic', path: 'value' };
const targetRef: FieldRef = { side: 'destination', namespace: 'saml.attribute', path: 'digest' };
const deferred = true;

function fixture() {
  const existing = vi.fn();
  const provision = vi.fn();
  const idFromName = vi.fn();
  const get = vi.fn(() => ({
    getExistingSecretRpc: existing,
    provisionMappingHashKeyRpc: provision,
  }));
  return { env: { KEY_MANAGER: { idFromName, get } }, existing, provision, idFromName, get };
}

function graph(operation: 'copy' | 'trim' = 'copy'): MappingRuleGraph {
  return {
    id: 'sync-receiver',
    targetRef,
    edges: [{ id: 'source', sourceRef, targetRef }],
    transforms: [
      { id: 'upstream', operation, inputs: [{ edgeIndex: 0 }] },
      {
        id: 'hash',
        operation: 'hash',
        parameters: { encoding: 'hex' },
        inputs: [{ stepIndex: 0 }],
      },
    ],
    output: { stepIndex: 1 },
  };
}

function input(rule: MappingRuleGraph, value: unknown): Omit<MappingInput, 'graphRules'> {
  return {
    catalog: {
      ...TEST_CATALOG,
      entries: [
        {
          id: 'source',
          namespace: sourceRef.namespace,
          path: sourceRef.path,
          valueType: 'string',
          cardinality: 'single',
          classification: 'public',
        },
        {
          id: 'destination',
          namespace: targetRef.namespace,
          path: targetRef.path,
          valueType: 'string',
          cardinality: 'single',
          classification: 'public',
        },
      ],
    },
    edges: rule.edges,
    sourceValues: [{ sourceRef, value, provenanceHint: { sourceId: 'synthetic-fixture' } }],
  };
}

function expectNoKeyAccess(f: ReturnType<typeof fixture>) {
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.existing).not.toHaveBeenCalled();
  expect(f.provision).not.toHaveBeenCalled();
}

describe('synchronous receiver hash preparation', () => {
  it.each([' synthetic ', ''])('defers only a valid string (%j) before consent', async (value) => {
    const f = fixture();
    const rule = graph('trim');
    const mapping = input(rule, value);
    mapping.validationRules = [{ id: 'required', kind: 'required', targetRef }];
    const preparedSteps = await prepareTenantMappingHashes(
      f.env,
      'tenant-a',
      [rule],
      mapping,
      deferred
    );

    expect([...preparedSteps.keys()]).toEqual(['hash']);
    expect(preparedSteps.get('hash')).toEqual({ kind: 'deferred' });
    const release = executeRuntimeMapping({
      ...mapping,
      graphRules: [rule],
      preparedSteps,
      allowDeferredOutputs: true,
    });
    expect(release.status).toBe('success');
    expect(release.values).toEqual([]);
    expect(release.deferredTargets).toEqual([targetRef]);
    const premature = executeRuntimeMapping({ ...mapping, graphRules: [rule], preparedSteps });
    expect(premature.status).toBe('failed');
    expect(premature.values).toEqual([]);
    expect(premature.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.deferred_output' })
    );
    expectNoKeyAccess(f);
  });

  describe.each([
    { phase: 'before consent', marker: deferred },
    { phase: 'at runtime', marker: false },
  ])('$phase', ({ marker }) => {
    it('preserves null through the preparedSteps seam without reading a key', async () => {
      const f = fixture();
      const rule = graph();
      const mapping = input(rule, null);
      const preparedSteps = await prepareTenantMappingHashes(
        f.env,
        'tenant-a',
        [rule],
        mapping,
        marker
      );
      expect(preparedSteps.get('hash')).toMatchObject({ kind: 'value', envelope: { value: null } });
      const result = evaluateMappingRule({
        rule,
        sourceValues: mapping.sourceValues,
        preparedSteps,
      });
      expect(result.output).toMatchObject({ kind: 'value', envelope: { value: null } });
      expect(result.reasons).toEqual([]);
      expectNoKeyAccess(f);
    });

    it.each([
      { kind: 'absent' },
      { kind: 'failed' },
      { kind: 'suppressed' },
    ] satisfies MappingEvaluationValue[])(
      'propagates $kind without a marker or key access',
      async (upstream) => {
        const f = fixture();
        const rule = graph();
        const mapping = input(rule, upstream.kind === 'absent' ? undefined : 'synthetic');
        // Trusted upstream preparation must survive both passes of a synchronous receiver.
        mapping.preparedSteps = new Map([['upstream', upstream]]);
        const hashes = await prepareTenantMappingHashes(f.env, 'tenant-a', [rule], mapping, marker);
        expect(hashes.size).toBe(0);
        const preparedSteps = new Map([...mapping.preparedSteps, ...hashes]);
        const result = evaluateMappingRule({
          rule,
          sourceValues: mapping.sourceValues,
          preparedSteps,
        });
        expect(result.output).toEqual(upstream);
        expect(result.steps.get(1)).toEqual(upstream);
        expect(
          executeRuntimeMapping({ ...mapping, graphRules: [rule], preparedSteps }).values
        ).toEqual([]);
        expectNoKeyAccess(f);
      }
    );
  });

  it.each([0, false, [], {}, ['synthetic']])(
    'never defers a non-string input (%j)',
    async (value) => {
      const f = fixture();
      const rule = graph();
      const mapping = input(rule, value);
      const preparedSteps = await prepareTenantMappingHashes(
        f.env,
        'tenant-a',
        [rule],
        mapping,
        deferred
      );
      expect(preparedSteps.get('hash')).toEqual({ kind: 'failed' });
      const release = executeRuntimeMapping({ ...mapping, graphRules: [rule], preparedSteps });
      expect(release.status).toBe('failed');
      expect(release.values).toEqual([]);
      expect(release.reasons).toContainEqual(
        expect.objectContaining({ code: 'transform.hash_unavailable' })
      );
      expectNoKeyAccess(f);
    }
  );

  it('prepares HMAC from the transformed dependency and releases it synchronously', async () => {
    const f = fixture();
    const bytes = new Uint8Array(32).fill(1);
    f.existing.mockResolvedValue({
      secretRef: MAPPING_HASH_SECRET_REF,
      active: { value: btoa(String.fromCharCode(...bytes)).replace(/=+$/u, '') },
    });
    const rule = graph('trim');
    const mapping = input(rule, ' synthetic ');
    const preparedSteps = await prepareTenantMappingHashes(f.env, 'tenant-a', [rule], mapping);
    const expected = createHmac('sha256', bytes).update('synthetic').digest('hex');
    expect(preparedSteps.get('hash')).toMatchObject({
      kind: 'value',
      envelope: { value: expected },
    });
    const release = executeRuntimeMapping({ ...mapping, graphRules: [rule], preparedSteps });
    expect(release.status).toBe('success');
    expect(release.values).toEqual([
      expect.objectContaining({ sourceRef: targetRef, value: expected }),
    ]);
    expect(f.idFromName).toHaveBeenCalledExactlyOnceWith('tenant-a-v3');
    expect(f.existing).toHaveBeenCalledExactlyOnceWith(MAPPING_HASH_SECRET_REF);
    expect(f.provision).not.toHaveBeenCalled();
  });

  it('carries key absence as a failed prepared step into final release failure', async () => {
    const f = fixture();
    f.existing.mockResolvedValue(null);
    const rule = graph('trim');
    rule.transforms.push({
      id: 'substitute',
      operation: 'default_if_empty',
      parameters: { value: 'forbidden substitute' },
      inputs: [{ stepIndex: 1 }],
    });
    rule.output = { stepIndex: 2 };
    const mapping = input(rule, ' synthetic ');
    const preparedSteps = await prepareTenantMappingHashes(f.env, 'tenant-a', [rule], mapping);
    expect(preparedSteps.get('hash')).toEqual({ kind: 'failed' });
    const release = executeRuntimeMapping({ ...mapping, graphRules: [rule], preparedSteps });
    expect(release.status).toBe('failed');
    expect(release.values).toEqual([]);
    expect(release.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.hash_unavailable', severity: 'critical' })
    );
    expect(f.existing).toHaveBeenCalledTimes(1);
    expect(f.provision).not.toHaveBeenCalled();
  });

  it.each([deferred, false])(
    'does not touch KeyManager for a hashless rule (%j)',
    async (marker) => {
      const f = fixture();
      const rule = graph('trim');
      rule.transforms.pop();
      rule.output = { stepIndex: 0 };
      const mapping = input(rule, ' synthetic ');
      expect(
        (await prepareTenantMappingHashes(f.env, 'tenant-a', [rule], mapping, marker)).size
      ).toBe(0);
      expectNoKeyAccess(f);
    }
  );
});
