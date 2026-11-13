import { describe, expect, it } from 'vitest';
import type { FlowRuntimeContract, FlowRuntimeStep } from '../../schemas/flow-runtime';
import {
  readFlowConsentStatements,
  ssoRequiredConsentStatementIds,
} from '../flow-consent-statements';
import { statementConsentExpired, statementConsentSatisfied } from '../statement-consent-writes';

function step(
  id: string,
  component: FlowRuntimeStep['component'],
  config?: Record<string, unknown>
): FlowRuntimeStep {
  return {
    id: `${id}:step`,
    source_node_id: id,
    component,
    render: true,
    ...(config ? { config: config as FlowRuntimeStep['config'] } : {}),
  };
}

function runtime(steps: FlowRuntimeStep[]): FlowRuntimeContract {
  return { flow_kind: 'login', ui: { steps } };
}

const tos = { statement_id: 'tos', required: true };
const news = { statement_id: 'news', required: false };

describe('readFlowConsentStatements', () => {
  it('reads the listed statements in order, required only when said so', async () => {
    expect(readFlowConsentStatements({ statements: [tos, { statement_id: 'news' }] })).toEqual([
      tos,
      news,
    ]);
    expect(readFlowConsentStatements({ statements: [] })).toEqual([]);
  });

  it('refuses a malformed list rather than asking for part of it', async () => {
    expect(readFlowConsentStatements({})).toBeNull();
    expect(readFlowConsentStatements({ statements: 'tos' })).toBeNull();
    expect(readFlowConsentStatements({ statements: [tos, tos] })).toBeNull();
    expect(readFlowConsentStatements({ statements: [{ statement_id: '' }] })).toBeNull();
    expect(
      readFlowConsentStatements({ statements: [{ statement_id: 'tos', required: 'yes' }] })
    ).toBeNull();
    expect(
      readFlowConsentStatements({
        statements: Array.from({ length: 51 }, (_, index) => ({ statement_id: `s${index}` })),
      })
    ).toBeNull();
  });
});

describe('ssoRequiredConsentStatementIds', () => {
  it('takes the required statements of a consent step every way goes through', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('auth', 'authentication_method_selector'),
      step('consent', 'consent_policy', { statements: [tos, news] }),
      step('done', 'completion'),
    ]);
    expect(await ssoRequiredConsentStatementIds(flow, null)).toEqual(['tos']);
  });

  it('requires a statement asked on one branch only, when the branch depends on the run', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('branch', 'condition'),
      step('consent', 'consent_policy', { statements: [tos] }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'branch' },
        { id: 'e2', source: 'branch', target: 'consent', source_handle: 'true' },
        { id: 'e3', source: 'branch', target: 'done', source_handle: 'false' },
        { id: 'e4', source: 'consent', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor)).toEqual(['tos']);
  });

  it('requires a statement behind a screen exit that may skip it', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('screen', 'screen'),
      step('consent', 'consent_policy', { statements: [tos] }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'screen' },
        { id: 'e2', source: 'screen', target: 'consent', source_handle: 'submitted' },
        { id: 'e3', source: 'screen', target: 'done', source_handle: 'skipped' },
        { id: 'e4', source: 'consent', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor)).toEqual(['tos']);
  });

  it('does not require a statement on a step no way reaches', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('done', 'completion'),
      step('orphan', 'consent_policy', { statements: [tos] }),
    ]);
    const editor = { edges: [{ id: 'e1', source: 'entry', target: 'done' }] };
    expect(await ssoRequiredConsentStatementIds(flow, editor)).toEqual([]);
  });

  it('keeps a step every branch joins again before the end', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('branch', 'condition'),
      step('a', 'screen'),
      step('b', 'screen'),
      step('consent', 'consent_policy', { statements: [tos] }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'branch' },
        { id: 'e2', source: 'branch', target: 'a', source_handle: 'true' },
        { id: 'e3', source: 'branch', target: 'b', source_handle: 'false' },
        { id: 'e4', source: 'a', target: 'consent' },
        { id: 'e5', source: 'b', target: 'consent' },
        { id: 'e6', source: 'consent', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor)).toEqual(['tos']);
  });
});

describe('ssoRequiredConsentStatementIds for a protocol', () => {
  it('follows the branch made for the request protocol, as the runtime does', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('oidc-consent', 'consent_policy', {
        statements: [tos],
        completion_block: { id: 'oidc', protocol: 'oidc' },
      }),
      step('saml-consent', 'consent_policy', {
        statements: [{ statement_id: 'saml-terms', required: true }],
        completion_block: { id: 'saml', protocol: 'saml' },
      }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'oidc-consent' },
        { id: 'e2', source: 'entry', target: 'saml-consent' },
        { id: 'e3', source: 'oidc-consent', target: 'done' },
        { id: 'e4', source: 'saml-consent', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc' })).toEqual([
      'tos',
    ]);
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'saml' })).toEqual([
      'saml-terms',
    ]);
    // Without a protocol either branch may be taken.
    expect(await ssoRequiredConsentStatementIds(flow, editor)).toEqual(['tos', 'saml-terms']);
  });
});

describe('statementConsentSatisfied', () => {
  const definition = {
    version: '20260301',
    required_consent_version: '20260201',
    reconsent_interval_days: null as number | null,
  };
  const record = (
    status: 'granted' | 'denied',
    version: string,
    expires_at: number | null = null
  ) => ({
    status,
    version,
    expires_at,
    granted_at: 1_000 as number | null,
    consent_settings_snapshot_at: 1_000 as number | null,
  });

  it('takes an agreement to a version at or after the one agreement is required from', async () => {
    expect(statementConsentSatisfied(record('granted', '20260301'), definition)).toBe(true);
    expect(statementConsentSatisfied(record('granted', '20260201'), definition)).toBe(true);
    expect(statementConsentSatisfied(record('granted', '20260101'), definition)).toBe(false);
  });

  it('requires the current version when the statement keeps no boundary', async () => {
    const current = {
      version: '20260301',
      required_consent_version: null,
      reconsent_interval_days: null,
    };
    expect(statementConsentSatisfied(record('granted', '20260201'), current)).toBe(false);
    expect(statementConsentSatisfied(record('granted', '20260301'), current)).toBe(true);
  });

  it('expires a record kept without a settings snapshot by the interval defined now', () => {
    const day = 24 * 60 * 60 * 1000;
    const legacy = {
      ...record('granted', '20260301'),
      granted_at: 0,
      consent_settings_snapshot_at: null,
    };
    const withInterval = { ...definition, reconsent_interval_days: 30 };
    expect(statementConsentSatisfied(legacy, withInterval, 31 * day)).toBe(false);
    expect(statementConsentSatisfied(legacy, withInterval, 29 * day)).toBe(true);
    // A record with its own snapshot keeps its own expiry.
    expect(statementConsentSatisfied(record('granted', '20260301'), withInterval, 31 * day)).toBe(
      true
    );
  });

  it('does not take a declined, missing or expired record', async () => {
    expect(statementConsentSatisfied(null, definition)).toBe(false);
    expect(statementConsentSatisfied(record('denied', '20260301'), definition)).toBe(false);
    expect(statementConsentSatisfied(record('granted', '20260301', 1_000), definition, 2_000)).toBe(
      false
    );
  });
});

describe('ssoRequiredConsentStatementIds through a condition', () => {
  const flow = runtime([
    step('entry', 'interaction_context'),
    step('branch', 'condition', {
      conditions: {
        rows: [
          { condition: { type: 'protocol', operator: 'eq', value: 'oidc' }, output_handle: 'oidc' },
          { condition: { type: 'first_login', value: true }, output_handle: 'first' },
        ],
        otherwise: { output_handle: 'other' },
      },
    }),
    step('consent', 'consent_policy', { statements: [tos] }),
    step('done', 'completion'),
  ]);
  const editor = {
    edges: [
      { id: 'e1', source: 'entry', target: 'branch' },
      { id: 'e2', source: 'branch', target: 'consent', source_handle: 'oidc' },
      { id: 'e3', source: 'branch', target: 'done', source_handle: 'first' },
      { id: 'e4', source: 'branch', target: 'done', source_handle: 'other' },
      { id: 'e5', source: 'consent', target: 'done' },
    ],
  };

  it('takes the branch a protocol condition chooses for the request', async () => {
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc' })).toEqual([
      'tos',
    ]);
  });

  it('keeps both ways open for a condition that depends on the run', async () => {
    // For SAML the protocol row is skipped; first_login cannot be judged before the run, and the
    // otherwise way skips the consent: the statement is not reached.
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'saml' })).toEqual([]);
  });

  it('requires the statement when a run-dependent row may lead to it', async () => {
    const runDependent = {
      edges: editor.edges.map((edge) => (edge.id === 'e3' ? { ...edge, target: 'consent' } : edge)),
    };
    expect(await ssoRequiredConsentStatementIds(flow, runDependent, { protocol: 'saml' })).toEqual([
      'tos',
    ]);
  });
});

describe('ssoRequiredConsentStatementIds and an app id the request does not have', () => {
  it('judges a SAML SP condition as not matching for an OIDC request', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('branch', 'condition', {
        conditions: {
          rows: [
            {
              condition: { type: 'saml_sp_id', value: 'https://sp.example' },
              output_handle: 'sp',
            },
          ],
          otherwise: { output_handle: 'other' },
        },
      }),
      step('consent', 'consent_policy', { statements: [tos] }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'branch' },
        { id: 'e2', source: 'branch', target: 'done', source_handle: 'sp' },
        { id: 'e3', source: 'branch', target: 'consent', source_handle: 'other' },
        { id: 'e4', source: 'consent', target: 'done' },
      ],
    };
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc', client_id: 'app' })
    ).toEqual(['tos']);
    // For that SP the branch skips the consent; for another SP it does not.
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, {
        protocol: 'saml',
        saml_sp_id: 'https://sp.example',
      })
    ).toEqual([]);
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, {
        protocol: 'saml',
        saml_sp_id: 'https://other.example',
      })
    ).toEqual(['tos']);
  });
});

describe('ssoRequiredConsentStatementIds through an action', () => {
  it('requires a statement on any outcome of an account action', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('action', 'account_action'),
      step('consent', 'consent_policy', { statements: [tos] }),
      step('other', 'consent_policy', { statements: [{ statement_id: 'extra', required: true }] }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'action' },
        { id: 'e2', source: 'action', target: 'consent', source_handle: 'completed' },
        { id: 'e3', source: 'action', target: 'other', source_handle: 'cancelled' },
        { id: 'e4', source: 'consent', target: 'done' },
        { id: 'e5', source: 'other', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc' })).toEqual([
      'tos',
      'extra',
    ]);
  });
});

describe('statementConsentExpired', () => {
  it('lets a re-agreement replace a legacy record the interval has run out on', () => {
    const day = 24 * 60 * 60 * 1000;
    const legacy = { expires_at: null, granted_at: 0, consent_settings_snapshot_at: null };
    expect(statementConsentExpired(legacy, { reconsent_interval_days: 30 }, 31 * day)).toBe(true);
    expect(statementConsentExpired(legacy, { reconsent_interval_days: 30 }, 29 * day)).toBe(false);
    expect(statementConsentExpired(legacy, { reconsent_interval_days: null }, 31 * day)).toBe(
      false
    );
  });
});

describe('ssoRequiredConsentStatementIds and a completion block the runtime does not read', () => {
  it('treats a block without an id as naming no protocol', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('consent', 'consent_policy', {
        statements: [tos],
        completion_block: { protocol: 'saml' },
      }),
      step('oidc-done', 'completion', { completion_block: { id: 'oidc', protocol: 'oidc' } }),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'consent' },
        { id: 'e2', source: 'entry', target: 'oidc-done' },
        { id: 'e3', source: 'consent', target: 'oidc-done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc' })).toEqual([
      'tos',
    ]);
  });
});

describe('ssoRequiredConsentStatementIds and next beside an unlabeled edge', () => {
  it('keeps the edge an explicit next leads to', async () => {
    const flow = runtime([
      step('entry', 'interaction_context'),
      step('branch', 'condition', {
        conditions: {
          rows: [{ condition: { type: 'always' }, output_handle: 'next' }],
        },
      }),
      step('consent', 'consent_policy', {
        statements: [tos],
        completion_block: { id: 'saml', protocol: 'saml' },
      }),
      step('done', 'completion'),
    ]);
    const editor = {
      edges: [
        { id: 'e1', source: 'entry', target: 'branch' },
        { id: 'e2', source: 'branch', target: 'consent', source_handle: 'next' },
        { id: 'e3', source: 'branch', target: 'done' },
        { id: 'e4', source: 'consent', target: 'done' },
      ],
    };
    expect(await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc' })).toEqual([
      'tos',
    ]);
  });
});

describe('ssoRequiredConsentStatementIds and conditions on the person', () => {
  // Everyone is asked the terms; someone not from JP is asked the local law too, and a minor the
  // guardian statement.
  const law = { statement_id: 'law', required: true };
  const guardian = { statement_id: 'guardian', required: true };
  const flow = runtime([
    step('entry', 'interaction_context'),
    step('terms', 'consent_policy', { statements: [tos] }),
    step('abroad', 'condition', {
      conditions: {
        rows: [
          {
            condition: {
              type: 'user.attribute',
              attribute: 'nationality',
              operator: 'ne',
              value: 'JP',
            },
            output_handle: 'yes',
          },
        ],
        otherwise: { output_handle: 'no' },
      },
    }),
    step('law', 'consent_policy', { statements: [law] }),
    step('minor', 'condition', {
      conditions: {
        rows: [
          {
            condition: {
              type: 'all',
              all: [
                { type: 'user.age', operator: 'lt', value: 18 },
                { type: 'client_id', value: 'kids' },
              ],
            },
            output_handle: 'yes',
          },
        ],
        otherwise: { output_handle: 'no' },
      },
    }),
    step('guardian', 'consent_policy', { statements: [guardian] }),
    step('done', 'completion'),
  ]);
  const editor = {
    edges: [
      { id: 'e1', source: 'entry', target: 'terms' },
      { id: 'e2', source: 'terms', target: 'abroad' },
      { id: 'e3', source: 'abroad', target: 'law', source_handle: 'yes' },
      { id: 'e4', source: 'abroad', target: 'minor', source_handle: 'no' },
      { id: 'e5', source: 'law', target: 'minor' },
      { id: 'e6', source: 'minor', target: 'guardian', source_handle: 'yes' },
      { id: 'e7', source: 'minor', target: 'done', source_handle: 'no' },
      { id: 'e8', source: 'guardian', target: 'done' },
    ],
  };
  const NOW = Date.UTC(2026, 10, 13);

  it('requires of each person only the statements their way asks', async () => {
    const read: string[][] = [];
    const as = (attributes: Record<string, string>) => ({
      protocol: 'oidc' as const,
      client_id: 'kids',
      now_ms: NOW,
      user_attributes: async (keys: string[]) => {
        read.push(keys);
        return attributes;
      },
    });
    expect(
      await ssoRequiredConsentStatementIds(
        flow,
        editor,
        as({ nationality: 'JP', birthdate: '1990-01-01' })
      )
    ).toEqual(['tos']);
    expect(
      await ssoRequiredConsentStatementIds(
        flow,
        editor,
        as({ nationality: 'US', birthdate: '2012-05-01' })
      )
    ).toEqual(['tos', 'law', 'guardian']);
    // Read once per walk, only the keys the conditions read.
    expect(read).toEqual([
      ['nationality', 'birthdate'],
      ['nationality', 'birthdate'],
    ]);
  });

  it('rules a way out when a judged part of an all condition does not hold', async () => {
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, {
        protocol: 'oidc',
        client_id: 'other',
      })
    ).toEqual(['tos', 'law']);
  });

  it('keeps every way open when the attributes are not read or cannot be', async () => {
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, { protocol: 'oidc', client_id: 'kids' })
    ).toEqual(['tos', 'law', 'guardian']);
    expect(
      await ssoRequiredConsentStatementIds(flow, editor, {
        protocol: 'oidc',
        client_id: 'kids',
        user_attributes: async () => {
          throw new Error('unreadable');
        },
      })
    ).toEqual(['tos', 'law', 'guardian']);
  });
});
