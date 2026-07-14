import { describe, expect, it, vi } from 'vitest';
import { executeServerFlow } from '../server-flow-execution';
import type { FlowRuntimeContract } from '../../schemas/flow-runtime';

const contract = (steps: FlowRuntimeContract['ui']['steps']): FlowRuntimeContract => ({
  flow_kind: 'credential_issuance',
  ui: { steps },
});

describe('executeServerFlow', () => {
  it('executes published system steps in order and shares transaction state', async () => {
    const order: string[] = [];
    const state = { claimsReady: false };
    const result = await executeServerFlow({
      contract: contract([
        { id: 'claims', source_node_id: 'n1', component: 'credential_claims', render: false },
        { id: 'offer', source_node_id: 'n2', component: 'credential_offer', render: false },
      ]),
      expectedKind: 'credential_issuance',
      state,
      handlers: {
        credential_claims: vi.fn(({ state: current }) => {
          current.claimsReady = true;
          order.push('claims');
          return { handle: 'resolved' };
        }),
        credential_offer: vi.fn(({ state: current }) => {
          if (!current.claimsReady) throw new Error('claims_missing');
          order.push('offer');
          return { handle: 'created' };
        }),
      },
    });
    expect(order).toEqual(['claims', 'offer']);
    expect(result.map((item) => item.handle)).toEqual(['resolved', 'created']);
  });

  it('fails closed for interactive or unimplemented components', async () => {
    await expect(
      executeServerFlow({
        contract: contract([{ id: 'form', source_node_id: 'n1', component: 'form', render: true }]),
        expectedKind: 'credential_issuance',
        state: {},
        handlers: {},
      })
    ).rejects.toThrow('server_flow_interactive_step_not_supported');
  });
});
