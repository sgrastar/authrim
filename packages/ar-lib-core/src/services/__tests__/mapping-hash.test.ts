import { describe, expect, it, vi } from 'vitest';
import {
  tenantMappingHashPreparer,
  executeTenantMapping,
  provisionMappingHashKey,
  MAPPING_HASH_SECRET_REF,
} from '../mapping-hash';
import { TEST_CATALOG } from '@authrim/ar-lib-field-mapping/test-support';
import { evaluatePreparedMappingRule } from '@authrim/ar-lib-field-mapping/authoring';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingRuleGraph,
} from '@authrim/ar-lib-field-mapping/contract';

const ref: FieldRef = { side: 'source', namespace: 'synthetic', path: 'value' };
function fixture() {
  const existing = vi.fn();
  const provision = vi.fn();
  const idFromName = vi.fn();
  const get = vi.fn(() => ({
    getExistingSecretRpc: existing,
    provisionMappingHashKeyRpc: provision,
  }));
  return { env: { KEY_MANAGER: { idFromName, get: vi.fn(get) } }, existing, provision, idFromName };
}
function request(value: unknown, encoding = 'hex') {
  return {
    step: { id: 'hash', operation: 'hash', parameters: { encoding }, inputs: [{ edgeIndex: 0 }] },
    inputs: [{ kind: 'value', envelope: { sourceRef: ref, value } }],
  } satisfies Parameters<ReturnType<typeof tenantMappingHashPreparer>>[0];
}
const installed = (byte: number) => ({
  secretRef: MAPPING_HASH_SECRET_REF,
  active: {
    value: btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, ''),
  },
});

describe('tenant mapping hash', () => {
  it('supports dynamic RPC stubs without property enumeration', async () => {
    const existing = vi.fn(async () => installed(1));
    const stub = new Proxy(
      {},
      {
        get: (_, name) => (name === 'getExistingSecretRpc' ? existing : undefined),
        has: () => false,
      }
    );
    const env = { KEY_MANAGER: { idFromName: vi.fn(), get: () => stub } };
    expect((await tenantMappingHashPreparer(env, 'tenant-a')(request('synthetic'))).kind).toBe(
      'value'
    );
    expect(existing).toHaveBeenCalledWith(MAPPING_HASH_SECRET_REF);
  });

  it('never creates a key on read or key absence and never uses a default secret', async () => {
    const f = fixture();
    f.existing.mockResolvedValue(null);
    const prepare = tenantMappingHashPreparer(f.env, 'tenant-a');
    expect(await prepare(request('synthetic'))).toEqual({ kind: 'failed' });
    expect(f.idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(f.existing).toHaveBeenCalledWith(MAPPING_HASH_SECRET_REF);
    expect(f.provision).not.toHaveBeenCalled();
  });
  it('isolates identical input by tenant key and changes output on rotation', async () => {
    const a = fixture();
    const b = fixture();
    a.existing.mockResolvedValue(installed(1));
    b.existing.mockResolvedValue(installed(2));
    const first = await tenantMappingHashPreparer(
      a.env,
      'tenant-a'
    )(request('same synthetic input'));
    const second = await tenantMappingHashPreparer(
      b.env,
      'tenant-b'
    )(request('same synthetic input'));
    expect(first.kind).toBe('value');
    expect(second.kind).toBe('value');
    expect(first).not.toEqual(second);
    expect(b.idFromName).not.toHaveBeenCalledWith('tenant-a-v3');
    a.existing.mockResolvedValue(installed(3));
    expect(
      await tenantMappingHashPreparer(a.env, 'tenant-a')(request('same synthetic input'))
    ).not.toEqual(first);
    // Restoring the same key restores output continuity.
    a.existing.mockResolvedValue(installed(1));
    expect(
      await tenantMappingHashPreparer(a.env, 'tenant-a')(request('same synthetic input'))
    ).toEqual(first);
  });
  it('matches an independently computed HMAC and base64url encoding', async () => {
    const f = fixture();
    f.existing.mockResolvedValue(installed(1));
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(1),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('synthetic'))
    );
    const prepare = tenantMappingHashPreparer(f.env, 'tenant-a');
    expect(await prepare(request('synthetic'))).toMatchObject({
      kind: 'value',
      envelope: { value: [...expected].map((byte) => byte.toString(16).padStart(2, '0')).join('') },
    });
    expect(await prepare(request('synthetic', 'base64url'))).toMatchObject({
      kind: 'value',
      envelope: {
        value: btoa(String.fromCharCode(...expected))
          .replace(/\+/gu, '-')
          .replace(/\//gu, '_')
          .replace(/=+$/u, ''),
      },
    });
    expect(f.existing).toHaveBeenCalledTimes(1);
  });
  it.each([0, false, [], {}, ['text']])(
    'refuses non-text input %j without consulting a key',
    async (value) => {
      const f = fixture();
      expect(await tenantMappingHashPreparer(f.env, 'tenant-a')(request(value))).toEqual({
        kind: 'failed',
      });
      expect(f.existing).not.toHaveBeenCalled();
    }
  );
  it('prepares transformed dependencies and skips absent, suppressed, failed and oversized inputs', async () => {
    const f = fixture();
    f.existing.mockResolvedValue(installed(1));
    const graph: MappingRuleGraph = {
      id: 'hash-rule',
      targetRef: ref,
      edges: [{ id: 'input', sourceRef: ref, targetRef: ref }],
      transforms: [
        { id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] },
        {
          id: 'hash',
          operation: 'hash',
          parameters: { encoding: 'hex' },
          inputs: [{ stepIndex: 0 }],
        },
      ],
      output: { stepIndex: 1 },
    };
    const result = await evaluatePreparedMappingRule(
      { rule: graph, sourceValues: [{ sourceRef: ref, value: ' synthetic ' }] },
      tenantMappingHashPreparer(f.env, 'tenant-a')
    );
    expect(result.output).toMatchObject(
      await tenantMappingHashPreparer(f.env, 'tenant-a')(request('synthetic'))
    );
    f.existing.mockClear();
    for (const prepared of [
      { kind: 'absent' },
      { kind: 'failed' },
      { kind: 'suppressed' },
    ] satisfies MappingEvaluationValue[]) {
      const result = await evaluatePreparedMappingRule(
        {
          rule: graph,
          sourceValues: [{ sourceRef: ref, value: 'synthetic' }],
          preparedSteps: new Map([['trim', prepared]]),
        },
        tenantMappingHashPreparer(f.env, 'tenant-a')
      );
      expect(result.output).toEqual(prepared);
    }
    await evaluatePreparedMappingRule(
      { rule: graph, sourceValues: [{ sourceRef: ref, value: 'x'.repeat(32768) }] },
      tenantMappingHashPreparer(f.env, 'tenant-a')
    );
    expect(f.existing).not.toHaveBeenCalled();
  });
  it('uses the authenticated tenant and releases no fallback when key acquisition fails', async () => {
    const f = fixture();
    const targetRef: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'mapped' };
    const graph: MappingRuleGraph = {
      id: 'runtime-hash',
      targetRef,
      edges: [{ id: 'edge', sourceRef: ref, targetRef }],
      transforms: [
        { id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] },
        {
          id: 'hash',
          operation: 'hash',
          parameters: { encoding: 'hex' },
          inputs: [{ stepIndex: 0 }],
        },
        {
          id: 'constant',
          operation: 'constant_text',
          parameters: { value: 'must not substitute' },
          inputs: [],
        },
        { id: 'fallback', operation: 'fallback', inputs: [{ stepIndex: 1 }, { stepIndex: 2 }] },
      ],
      output: { stepIndex: 3 },
    };
    const input = {
      graphRules: [graph],
      edges: graph.edges,
      catalog: {
        ...TEST_CATALOG,
        entries: [
          {
            id: 'in',
            namespace: 'synthetic',
            path: 'value',
            valueType: 'string',
            cardinality: 'single',
            classification: 'public',
          },
          {
            id: 'out',
            namespace: 'oidc.claim',
            path: 'mapped',
            valueType: 'string',
            cardinality: 'single',
            classification: 'public',
          },
        ],
      },
      sourceValues: [{ sourceRef: ref, value: ' synthetic ' }],
      runtimeContext: { tenantId: 'tenant-b' },
    } satisfies Parameters<typeof executeTenantMapping>[2];
    f.existing.mockResolvedValue(null);
    const failed = await executeTenantMapping(f.env, 'tenant-a', input);
    expect(failed.status).toBe('failed');
    expect(failed.values).toEqual([]);
    expect(failed.reasons.map((reason) => reason.code)).toContain('transform.hash_unavailable');
    expect(f.idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(f.idFromName).not.toHaveBeenCalledWith('tenant-b-v3');
    expect(f.provision).not.toHaveBeenCalled();
    f.existing.mockResolvedValue(installed(1));
    expect((await executeTenantMapping(f.env, 'tenant-a', input)).status).toBe('success');
    f.existing.mockClear();
    graph.transforms[1].parameters = { encoding: 'hex', tenantId: 'tenant-b' };
    const invalid = await executeTenantMapping(f.env, 'tenant-a', input);
    expect(invalid.status).not.toBe('success');
    expect(invalid.values).toEqual([]);
    expect(f.existing).not.toHaveBeenCalled();
  });

  it('enrolls only authored hash use and propagates provisioning failures', async () => {
    const f = fixture();
    await provisionMappingHashKey(f.env, 'tenant-a', [{ transforms: [{ operation: 'trim' }] }]);
    expect(f.provision).not.toHaveBeenCalled();
    await provisionMappingHashKey(f.env, 'tenant-a', [{ transforms: [{ operation: 'hash' }] }]);
    expect(f.provision).toHaveBeenCalledTimes(1);
    f.provision.mockRejectedValue(new Error('unavailable'));
    await expect(
      provisionMappingHashKey(f.env, 'tenant-a', [{ transforms: [{ operation: 'hash' }] }])
    ).rejects.toThrow('unavailable');
  });
});
