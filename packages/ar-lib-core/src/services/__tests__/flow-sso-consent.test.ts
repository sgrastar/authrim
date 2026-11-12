import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { FlowRuntimeContract } from '../../schemas/flow-runtime';
import { ssoConsentStatementsForTarget } from '../flow-sso-consent';

const flow = (statements: string[]): string =>
  JSON.stringify({
    flow_kind: 'login',
    ui: {
      steps: [
        { id: 'auth:step', source_node_id: 'auth', component: 'authentication_method_selector' },
        {
          id: 'consent:step',
          source_node_id: 'consent',
          component: 'consent_policy',
          config: {
            statements: statements.map((statement_id) => ({ statement_id, required: true })),
          },
        },
        { id: 'done:step', source_node_id: 'done', component: 'completion' },
      ],
    },
  } satisfies FlowRuntimeContract);

/** An adapter that answers the assignment lookup by the target it is asked for. */
function adapter(versions: { specific?: string; tenant?: string }) {
  const queryOne = vi.fn(async (sql: string) => {
    const runtime = sql.includes("a.target_type = 'tenant'") ? versions.tenant : versions.specific;
    return runtime ? { runtime_snapshot_json: runtime, editor_snapshot_json: null } : null;
  });
  return { queryOne } as unknown as DatabaseAdapter;
}

const target = { type: 'oidc_client', id: 'client-1' } as const;

describe('ssoConsentStatementsForTarget', () => {
  it("uses the app's own sign-in Flow over the tenant's", async () => {
    const db = adapter({ specific: flow(['own']), tenant: flow(['tenant']) });
    expect(await ssoConsentStatementsForTarget(db, 'default', target)).toEqual([
      { statement_id: 'own', required: true },
    ]);
  });

  it("falls back to the tenant's Flow when the app has none", async () => {
    const db = adapter({ tenant: flow(['tenant-a', 'tenant-b']) });
    expect(await ssoConsentStatementsForTarget(db, 'default', target)).toEqual([
      { statement_id: 'tenant-a', required: true },
      { statement_id: 'tenant-b', required: true },
    ]);
  });

  it('requires nothing with no assigned Flow or an unreadable one', async () => {
    expect(await ssoConsentStatementsForTarget(adapter({}), 'default', target)).toEqual([]);
    expect(
      await ssoConsentStatementsForTarget(adapter({ specific: '{not json' }), 'default', target)
    ).toEqual([]);
  });
});
