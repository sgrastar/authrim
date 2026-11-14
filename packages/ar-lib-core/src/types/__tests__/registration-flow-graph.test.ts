import { describe, expect, it } from 'vitest';
import { validateFlowEditorState } from '../../schemas/flow-runtime';
import {
  buildRegistrationFlowEditor,
  defaultRegistrationFlowSpec,
  readRegistrationFlowEditor,
  type RegistrationFlowSpec,
} from '../registration-flow-graph';

const errorsOf = (editor: unknown) =>
  validateFlowEditorState(editor, { for_publish: true }).filter((issue) => issue.level === 'error');

describe('a sign-up Flow’s graph', () => {
  it('builds the default as a Flow that can be published', () => {
    const editor = buildRegistrationFlowEditor(defaultRegistrationFlowSpec());
    expect(editor.nodes.map((node) => node.id)).toEqual([
      'request',
      'registration',
      'email-check',
      'account-create',
      'output',
    ]);
    expect(errorsOf(editor)).toEqual([]);
    // The method chosen goes on by order: no edge is tied to a method.
    expect(editor.edges.some((edge) => edge.source === 'registration')).toBe(false);
  });

  it('reads back the spec it was built from', () => {
    const spec: RegistrationFlowSpec = {
      ...defaultRegistrationFlowSpec(),
      profileRef: 'members',
      screenKey: 'registration_custom',
      screenTitle: 'Your details',
      screens: [
        {
          n: 1,
          screenKey: 'survey',
          exits: { social: 'complete', skipped: 'screen:2', submitted: 'complete' },
        },
        { n: 2, screenKey: 'more', title: 'Last step', exits: {} },
      ],
    };
    spec.policy.email_check = 'later';
    const editor = buildRegistrationFlowEditor(spec);
    expect(editor.nodes.map((node) => node.id)).toEqual([
      'request',
      'registration',
      'screen-1',
      'screen-2',
      'account-create',
      'output',
    ]);
    expect(errorsOf(editor)).toEqual([]);
    expect(readRegistrationFlowEditor(editor)).toEqual(spec);
  });

  it('leaves out an exit to nowhere it knows', () => {
    const spec: RegistrationFlowSpec = {
      ...defaultRegistrationFlowSpec(),
      screens: [{ n: 1, screenKey: 'survey', exits: { social: 'screen:9', Bad: 'complete' } }],
    };
    const edges = buildRegistrationFlowEditor(spec).edges.filter(
      (edge) => edge.source === 'screen-1'
    );
    expect(edges.map((edge) => edge.source_handle)).toEqual(['submitted']);
  });

  it('reads nothing from a graph of another shape', () => {
    expect(readRegistrationFlowEditor({ nodes: [], edges: [] })).toBeNull();
    expect(readRegistrationFlowEditor(null)).toBeNull();
  });
});

describe('a sign-up Flow’s consent', () => {
  const consent = [
    { statement_id: 'tos', required: true },
    { statement_id: 'news', required: false },
  ];

  it('is its own step right before the account is made, read back in order', () => {
    const spec: RegistrationFlowSpec = {
      ...defaultRegistrationFlowSpec(),
      screens: [{ n: 1, screenKey: 'profile', exits: { skipped: 'complete' } }],
      consents: [{ statements: consent }],
    };
    const editor = buildRegistrationFlowEditor(spec);
    const order = editor.nodes.map((node) => node.id);
    expect(order.slice(-3)).toEqual(['consent', 'account-create', 'output']);
    expect(editor.nodes.find((node) => node.id === 'consent')?.config?.statements).toEqual(consent);
    // The registration step itself asks nothing.
    expect(editor.nodes.find((node) => node.id === 'registration')?.config).not.toHaveProperty(
      'statements'
    );
    // A screen's way to the end goes through the consent step.
    expect(editor.edges.find((edge) => edge.id === 'screen-1:skipped')?.target).toBe('consent');
    expect(editor.edges.find((edge) => edge.id === 'consent:accepted')?.target).toBe(
      'account-create'
    );
    expect(errorsOf(editor)).toEqual([]);
    expect(readRegistrationFlowEditor(JSON.parse(JSON.stringify(editor)))).toEqual(spec);
  });

  it('is not there when nothing is asked', () => {
    const none = buildRegistrationFlowEditor(defaultRegistrationFlowSpec());
    expect(none.nodes.some((node) => node.type === 'consent')).toBe(false);
    expect(readRegistrationFlowEditor(none)?.consents).toEqual([]);
  });
});

describe('a sign-up Flow’s steps shown to some people', () => {
  const abroad = [
    {
      type: 'user.attribute' as const,
      attribute: 'nationality',
      operator: 'ne' as const,
      value: 'JP',
    },
  ];
  const minor = [
    { type: 'user.age' as const, operator: 'lt' as const, value: 18 },
    { type: 'client_id' as const, value: 'kids' },
  ];
  const spec: RegistrationFlowSpec = {
    ...defaultRegistrationFlowSpec(),
    policy: { ...defaultRegistrationFlowSpec().policy, email_check: 'later' },
    screens: [
      { n: 1, screenKey: 'profile', exits: {} },
      { n: 2, screenKey: 'school', exits: { skipped: 'complete' }, when: minor },
      { n: 3, screenKey: 'survey', exits: { back: 'screen:2' } },
    ],
    consents: [
      { statements: [{ statement_id: 'tos', required: true }] },
      { statements: [{ statement_id: 'law', required: true }], when: abroad },
      { statements: [{ statement_id: 'guardian', required: true }], when: minor },
    ],
  };
  const editor = buildRegistrationFlowEditor(spec);
  const target = (id: string) => editor.edges.find((edge) => edge.id === id)?.target;

  it('puts a condition node before each such step, in running order', () => {
    expect(editor.nodes.map((node) => node.id)).toEqual([
      'request',
      'registration',
      'screen-1',
      'when-screen-2',
      'screen-2',
      'screen-3',
      'consent',
      'when-consent-2',
      'consent-2',
      'when-consent-3',
      'consent-3',
      'account-create',
      'output',
    ]);
    // An `all` for more than one condition, one condition as it is.
    expect(
      editor.nodes.find((node) => node.id === 'when-consent-2')?.config?.conditions
    ).toMatchObject({
      rows: [{ condition: abroad[0], output_handle: 'show' }],
      otherwise: { output_handle: 'skip' },
    });
    expect(
      editor.nodes.find((node) => node.id === 'when-screen-2')?.config?.conditions
    ).toMatchObject({
      rows: [{ condition: { type: 'all', all: minor } }],
    });
    expect(errorsOf(editor)).toEqual([]);
  });

  it('sends every way into such a step through its condition, and its skip past it', () => {
    expect(target('screen-1:submitted')).toBe('when-screen-2');
    expect(target('when-screen-2:show')).toBe('screen-2');
    expect(target('when-screen-2:skip')).toBe('screen-3');
    // An exit back to a screen shown to some people is checked again.
    expect(target('screen-3:back')).toBe('when-screen-2');
    expect(target('consent:accepted')).toBe('when-consent-2');
    expect(target('when-consent-2:skip')).toBe('when-consent-3');
    expect(target('consent-2:accepted')).toBe('when-consent-3');
    expect(target('when-consent-3:skip')).toBe('account-create');
    expect(target('consent-3:accepted')).toBe('account-create');
  });

  it('starts at a conditional first consent step when a screen goes to the end', () => {
    const first = buildRegistrationFlowEditor({
      ...spec,
      consents: [spec.consents[1], spec.consents[0]],
    });
    expect(first.edges.find((edge) => edge.id === 'screen-2:skipped')?.target).toBe('when-consent');
    expect(readRegistrationFlowEditor(JSON.parse(JSON.stringify(first)))).toEqual({
      ...spec,
      consents: [spec.consents[1], spec.consents[0]],
    });
  });

  it('reads back what it was built from', () => {
    expect(readRegistrationFlowEditor(JSON.parse(JSON.stringify(editor)))).toEqual(spec);
  });

  it('is not the console’s when a condition node was changed by hand', () => {
    const changed = JSON.parse(JSON.stringify(editor)) as typeof editor;
    const node = changed.nodes.find((candidate) => candidate.id === 'when-consent-2');
    (node!.config!.conditions as { otherwise: unknown }).otherwise = { output_handle: 'other' };
    expect(readRegistrationFlowEditor(changed)).toBeNull();
  });
});

describe('a sign-up Flow’s consent steps, at most', () => {
  it('refuses more than it can read back', () => {
    const six = Array.from({ length: 6 }, () => ({
      statements: [{ statement_id: 'tos', required: true }],
    }));
    expect(() =>
      buildRegistrationFlowEditor({ ...defaultRegistrationFlowSpec(), consents: six })
    ).toThrow('too_many_consent_steps');
  });
});
