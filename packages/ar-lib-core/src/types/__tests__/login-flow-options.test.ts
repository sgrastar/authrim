import { describe, expect, it } from 'vitest';
import {
  applyLoginFlowSpec,
  buildLoginFlowEditor,
  canSetSignInConsent,
  defaultLoginFlowSpec,
  readLoginFlowEditor,
  SIGN_IN_CONSENT_PREFIX,
} from '../login-flow-graph';
import { validateFlowEditorState, type FlowEditorState } from '../../schemas/flow-runtime';
import { signInOptionsOfRuntime } from '../../services/flow-profile-refs';

describe('a sign-in Flow’s options', () => {
  it('starts from the safe defaults and writes nothing for them', () => {
    const editor = buildLoginFlowEditor(defaultLoginFlowSpec());
    const step = editor.nodes.find((node) => node.type === 'authentication');
    expect(step?.config).not.toHaveProperty('unregistered_signin');
    expect(step?.config).not.toHaveProperty('on_cancel');
    expect(readLoginFlowEditor(editor)).toMatchObject({
      unregistered: 'generic',
      onCancel: 'stay',
    });
  });

  it('saves what is chosen, reads it back, and clears it when set back', () => {
    const spec = { ...defaultLoginFlowSpec(), unregistered: 'guide', onCancel: 'error' } as const;
    const editor = buildLoginFlowEditor(spec);
    expect(readLoginFlowEditor(editor)).toMatchObject({ unregistered: 'guide', onCancel: 'error' });
    const back = applyLoginFlowSpec(editor, defaultLoginFlowSpec());
    const step = back?.nodes.find((node) => node.type === 'authentication');
    expect(step?.config).not.toHaveProperty('unregistered_signin');
    expect(step?.config).not.toHaveProperty('on_cancel');
  });

  it('reads them from a runtime contract, anything unknown as the safe default', () => {
    const runtime = (config: Record<string, unknown>) => ({
      ui: { steps: [{ component: 'authentication_method_selector', config }] },
    });
    expect(
      signInOptionsOfRuntime(runtime({ unregistered_signin: 'guide', on_cancel: 'error' }))
    ).toEqual({ unregistered: 'guide', onCancel: 'error' });
    expect(signInOptionsOfRuntime(runtime({ unregistered_signin: 'loud', on_cancel: 1 }))).toEqual({
      unregistered: 'generic',
      onCancel: 'stay',
    });
    expect(signInOptionsOfRuntime(null)).toEqual({ unregistered: 'generic', onCancel: 'stay' });
  });
});

describe('a sign-in Flow’s consent steps', () => {
  const consent = [
    { statement_id: 'tos', required: true },
    { statement_id: 'news', required: false },
  ];
  const consents = [{ statements: consent }];
  const publishErrors = (editor: unknown) =>
    validateFlowEditorState(editor, { for_publish: true }).filter(
      (issue) => issue.level === 'error'
    );
  /** A Flow as the seed makes it: completions reached straight from the session check. */
  const seeded = (): FlowEditorState => ({
    nodes: [
      { id: 'request', type: 'entry', position: { x: 0, y: 0 } },
      { id: 'session-check', type: 'session_check', position: { x: 0, y: 144 } },
      {
        id: 'authentication',
        type: 'authentication',
        position: { x: 0, y: 288 },
        config: { screen_ref: 'login' },
      },
      {
        id: 'saml-done',
        type: 'complete',
        position: { x: 0, y: 576 },
        config: { completion_block: { id: 'saml', protocol: 'saml' } },
      },
      {
        id: 'oidc-done',
        type: 'complete',
        position: { x: 300, y: 576 },
        config: { completion_block: { id: 'oidc', protocol: 'oidc' } },
      },
    ],
    edges: [
      { id: 'a', source: 'request', source_handle: 'next', target: 'session-check' },
      { id: 'b', source: 'session-check', source_handle: 'continue', target: 'saml-done' },
      { id: 'c', source: 'session-check', source_handle: 'continue', target: 'oidc-done' },
      { id: 'd', source: 'session-check', source_handle: 'authenticate', target: 'authentication' },
      { id: 'e', source: 'authentication', source_handle: 'passkey', target: 'saml-done' },
      { id: 'f', source: 'authentication', source_handle: 'passkey', target: 'oidc-done' },
    ],
  });

  it('puts one right before each completion of a new Flow and reads them back', () => {
    const editor = buildLoginFlowEditor({ ...defaultLoginFlowSpec(), consents });
    const order = editor.nodes.map((node) => node.id);
    expect(order.slice(-4)).toEqual([
      `${SIGN_IN_CONSENT_PREFIX}saml-complete`,
      'saml-complete',
      `${SIGN_IN_CONSENT_PREFIX}oidc-complete`,
      'oidc-complete',
    ]);
    // The sign-in step still goes on to the protocol branch; each branch to its own consent step.
    expect(order[order.indexOf('authentication') + 1]).toBe('protocol');
    expect(
      editor.edges
        .filter((edge) => edge.source === 'protocol')
        .map((edge) => [edge.source_handle, edge.target])
    ).toEqual([
      ['saml', `${SIGN_IN_CONSENT_PREFIX}saml-complete`],
      ['oidc', `${SIGN_IN_CONSENT_PREFIX}oidc-complete`],
    ]);
    expect(readLoginFlowEditor(JSON.parse(JSON.stringify(editor)))?.consents).toEqual(consents);
    expect(publishErrors(editor)).toEqual([]);
  });

  it('changes only the steps when the statements change, and puts the Flow back when taken out', () => {
    const original = seeded();
    const spec = { ...readLoginFlowEditor(original)!, consents };
    const withConsent = applyLoginFlowSpec(original, spec)!;
    expect(withConsent.edges.find((edge) => edge.id === 'b')?.target).toBe(
      `${SIGN_IN_CONSENT_PREFIX}saml-done`
    );
    expect(withConsent.edges.find((edge) => edge.id === 'f')?.target).toBe(
      `${SIGN_IN_CONSENT_PREFIX}oidc-done`
    );
    const changed = applyLoginFlowSpec(withConsent, {
      ...spec,
      consents: [{ statements: [consent[0]] }],
    })!;
    expect(changed.edges).toEqual(withConsent.edges);
    expect(readLoginFlowEditor(changed)?.consents).toEqual([{ statements: [consent[0]] }]);
    const back = applyLoginFlowSpec(changed, { ...spec, consents: [] })!;
    expect(back.nodes.map((node) => node.id)).toEqual(original.nodes.map((node) => node.id));
    expect(back.edges).toEqual(original.edges);
  });

  it('sends an edge drawn to a completion later through its consent step on the next save', () => {
    const spec = { ...readLoginFlowEditor(seeded())!, consents };
    const withConsent = applyLoginFlowSpec(seeded(), spec)!;
    // Drawn in the Flow editor afterwards, straight to the completion.
    withConsent.edges.push({
      id: 'g',
      source: 'request',
      source_handle: 'skip',
      target: 'oidc-done',
    });
    const saved = applyLoginFlowSpec(withConsent, spec)!;
    expect(saved.edges.find((edge) => edge.id === 'g')?.target).toBe(
      `${SIGN_IN_CONSENT_PREFIX}oidc-done`
    );
    // Only the consent steps lead to the completions.
    expect(
      saved.edges
        .filter((edge) => edge.target === 'saml-done' || edge.target === 'oidc-done')
        .every((edge) => edge.source.startsWith(SIGN_IN_CONSENT_PREFIX))
    ).toBe(true);
    expect(saved.nodes.filter((node) => node.type === 'consent')).toHaveLength(2);
  });

  it('sends a step without edges that went on to a completion through the consent step', () => {
    const implicit = seeded();
    // The sign-in step has no edges: it goes on to the step after it, the SAML completion.
    implicit.edges = implicit.edges.filter((edge) => edge.source !== 'authentication');
    const saved = applyLoginFlowSpec(implicit, { ...readLoginFlowEditor(implicit)!, consents })!;
    const order = saved.nodes.map((node) => node.id);
    expect(order[order.indexOf('authentication') + 1]).toBe(`${SIGN_IN_CONSENT_PREFIX}saml-done`);
  });

  it('puts a consent step before a completion reached only as the next step in order', () => {
    const implicit = seeded();
    // A is gone on to only after the sign-in step (no edges); B by an edge.
    implicit.edges = implicit.edges.filter(
      (edge) => edge.source !== 'authentication' && edge.target !== 'saml-done'
    );
    expect(canSetSignInConsent(implicit)).toBe(true);
    const saved = applyLoginFlowSpec(implicit, { ...readLoginFlowEditor(implicit)!, consents })!;
    const order = saved.nodes.map((node) => node.id);
    expect(order[order.indexOf('authentication') + 1]).toBe(`${SIGN_IN_CONSENT_PREFIX}saml-done`);
    expect(order).toContain(`${SIGN_IN_CONSENT_PREFIX}oidc-done`);
    // Taken out, the order is as it was.
    const back = applyLoginFlowSpec(saved, { ...readLoginFlowEditor(saved)!, consents: [] })!;
    expect(back.nodes.map((node) => node.id)).toEqual(implicit.nodes.map((node) => node.id));
    expect(back.edges).toEqual(implicit.edges);
  });

  it('leaves a consent step rewired in the Flow editor as it is', () => {
    const withConsent = applyLoginFlowSpec(seeded(), {
      ...readLoginFlowEditor(seeded())!,
      consents,
    })!;
    withConsent.edges.push({
      id: 'extra',
      source: `${SIGN_IN_CONSENT_PREFIX}saml-done`,
      source_handle: 'accepted',
      target: 'oidc-done',
    });
    expect(canSetSignInConsent(withConsent)).toBe(false);
    expect(readLoginFlowEditor(withConsent)?.consents).toEqual([]);
  });

  it('leaves consent set differently in the Flow editor as it is', () => {
    const withConsent = applyLoginFlowSpec(seeded(), {
      ...readLoginFlowEditor(seeded())!,
      consents,
    })!;
    const oidc = withConsent.nodes.find(
      (node) => node.id === `${SIGN_IN_CONSENT_PREFIX}oidc-done`
    )!;
    oidc.config = { ...oidc.config, statements: [{ statement_id: 'other', required: true }] };
    expect(canSetSignInConsent(withConsent)).toBe(false);
    const spec = readLoginFlowEditor(withConsent)!;
    expect(spec.consents).toEqual([]);
    // Saving the other settings changes neither step.
    const saved = applyLoginFlowSpec(withConsent, { ...spec, onCancel: 'error' })!;
    expect(saved.nodes.filter((node) => node.type === 'consent')).toEqual(
      withConsent.nodes.filter((node) => node.type === 'consent')
    );
    expect(saved.edges).toEqual(withConsent.edges);
    expect(applyLoginFlowSpec(withConsent, { ...spec, consents })).toBeNull();
  });

  it('is not put in a Flow no edge leads to a completion in', () => {
    const open = seeded();
    open.edges = open.edges.filter((edge) => !edge.target.endsWith('-done'));
    // The sign-in step leads elsewhere, so the completion after it is not its next step either.
    open.edges.push({
      id: 'loop',
      source: 'authentication',
      source_handle: 'passkey',
      target: 'request',
    });
    expect(canSetSignInConsent(open)).toBe(false);
    expect(applyLoginFlowSpec(open, { ...readLoginFlowEditor(open)!, consents })).toBeNull();
    // Without consent the Flow is still set as before.
    expect(applyLoginFlowSpec(open, readLoginFlowEditor(open)!)).not.toBeNull();
    expect(canSetSignInConsent(seeded())).toBe(true);
  });
});

describe('a sign-in Flow’s consent steps shown to some people', () => {
  const terms = [{ statement_id: 'tos', required: true }];
  const law = [{ statement_id: 'law', required: true }];
  const abroad = [
    {
      type: 'user.attribute' as const,
      attribute: 'nationality',
      operator: 'ne' as const,
      value: 'JP',
    },
  ];
  const consents = [{ statements: terms }, { statements: law, when: abroad }];
  const editor = buildLoginFlowEditor({ ...defaultLoginFlowSpec(), consents });
  const target = (id: string) => editor.edges.find((edge) => edge.id === id)?.target;

  it('chains the steps before each completion, a condition before the one shown to some', () => {
    const ids = editor.nodes.map((node) => node.id);
    for (const completion of ['saml-complete', 'oidc-complete']) {
      const at = ids.indexOf(completion);
      expect(ids.slice(at - 3, at)).toEqual([
        `sign-in-consent-${completion}`,
        `sign-in-when2-${completion}`,
        `sign-in-consent2-${completion}`,
      ]);
      expect(target(`protocol:${completion.split('-')[0]}`)).toBe(`sign-in-consent-${completion}`);
      expect(target(`sign-in-consent-${completion}:accepted`)).toBe(`sign-in-when2-${completion}`);
      expect(target(`sign-in-when2-${completion}:show`)).toBe(`sign-in-consent2-${completion}`);
      expect(target(`sign-in-when2-${completion}:skip`)).toBe(completion);
      expect(target(`sign-in-consent2-${completion}:accepted`)).toBe(completion);
    }
    expect(
      validateFlowEditorState(editor, { for_publish: true }).filter(
        (issue) => issue.level === 'error'
      )
    ).toEqual([]);
  });

  it('reads back the steps, and can be changed and taken out again', () => {
    const copy = JSON.parse(JSON.stringify(editor)) as FlowEditorState;
    const spec = readLoginFlowEditor(copy)!;
    expect(spec.consents).toEqual(consents);
    // The first step shown to some people too: its condition is the way in from the protocol.
    const changed = applyLoginFlowSpec(copy, {
      ...spec,
      consents: [{ statements: law, when: abroad }],
    })!;
    expect(changed.edges.find((edge) => edge.id === 'protocol:oidc')?.target).toBe(
      'sign-in-when-oidc-complete'
    );
    expect(readLoginFlowEditor(changed)?.consents).toEqual([{ statements: law, when: abroad }]);
    const back = applyLoginFlowSpec(changed, { ...spec, consents: [] })!;
    expect(back.nodes.some((node) => node.id.startsWith('sign-in-'))).toBe(false);
    expect(back.edges.find((edge) => edge.id === 'protocol:oidc')?.target).toBe('oidc-complete');
  });

  it('is not the console’s when a condition was rewired in the Flow editor', () => {
    const rewired = JSON.parse(JSON.stringify(editor)) as FlowEditorState;
    const skip = rewired.edges.find((edge) => edge.id === 'sign-in-when2-oidc-complete:skip')!;
    skip.target = 'saml-complete';
    expect(canSetSignInConsent(rewired)).toBe(false);
    expect(readLoginFlowEditor(rewired)?.consents).toEqual([]);
  });
});

describe('saving a sign-in Flow with the console’s consent steps again', () => {
  const terms = [{ statement_id: 'tos', required: true }];

  it('keeps what a step had beyond what the console sets', () => {
    const editor = buildLoginFlowEditor({
      ...defaultLoginFlowSpec(),
      consents: [{ statements: terms }],
    });
    const step = editor.nodes.find((node) => node.id === 'sign-in-consent-oidc-complete')!;
    step.config = { ...step.config, screen_ref: 'my-consent' };
    step.position = { x: 9, y: 9 };
    const saved = applyLoginFlowSpec(editor, {
      ...readLoginFlowEditor(editor)!,
      onCancel: 'error',
    })!;
    const again = saved.nodes.find((node) => node.id === 'sign-in-consent-oidc-complete')!;
    expect(again.config).toMatchObject({ screen_ref: 'my-consent', statements: terms });
    expect(again.position).toEqual({ x: 9, y: 9 });
  });

  it('refuses more consent steps than it can read back', () => {
    const six = Array.from({ length: 6 }, () => ({ statements: terms }));
    expect(() => buildLoginFlowEditor({ ...defaultLoginFlowSpec(), consents: six })).toThrow(
      'too_many_consent_steps'
    );
  });
});

describe('a sign-in Flow whose consent steps were moved in the order', () => {
  it('is not the console’s: putting them back would change where a step goes in order', () => {
    const editor = buildLoginFlowEditor({
      ...defaultLoginFlowSpec(),
      consents: [{ statements: [{ statement_id: 'tos', required: true }] }],
    });
    const moved = JSON.parse(JSON.stringify(editor)) as FlowEditorState;
    const at = moved.nodes.findIndex((node) => node.id === 'sign-in-consent-oidc-complete');
    const [step] = moved.nodes.splice(at, 1);
    moved.nodes.splice(1, 0, step);
    expect(canSetSignInConsent(moved)).toBe(false);
  });
});
