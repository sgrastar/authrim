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
    const editor = buildLoginFlowEditor({ ...defaultLoginFlowSpec(), consent });
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
    expect(readLoginFlowEditor(JSON.parse(JSON.stringify(editor)))?.consent).toEqual(consent);
    expect(publishErrors(editor)).toEqual([]);
  });

  it('changes only the steps when the statements change, and puts the Flow back when taken out', () => {
    const original = seeded();
    const spec = { ...readLoginFlowEditor(original)!, consent };
    const withConsent = applyLoginFlowSpec(original, spec)!;
    expect(withConsent.edges.find((edge) => edge.id === 'b')?.target).toBe(
      `${SIGN_IN_CONSENT_PREFIX}saml-done`
    );
    expect(withConsent.edges.find((edge) => edge.id === 'f')?.target).toBe(
      `${SIGN_IN_CONSENT_PREFIX}oidc-done`
    );
    const changed = applyLoginFlowSpec(withConsent, { ...spec, consent: [consent[0]] })!;
    expect(changed.edges).toEqual(withConsent.edges);
    expect(readLoginFlowEditor(changed)?.consent).toEqual([consent[0]]);
    const back = applyLoginFlowSpec(changed, { ...spec, consent: [] })!;
    expect(back.nodes.map((node) => node.id)).toEqual(original.nodes.map((node) => node.id));
    expect(back.edges).toEqual(original.edges);
  });

  it('sends an edge drawn to a completion later through its consent step on the next save', () => {
    const spec = { ...readLoginFlowEditor(seeded())!, consent };
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
    const saved = applyLoginFlowSpec(implicit, { ...readLoginFlowEditor(implicit)!, consent })!;
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
    const saved = applyLoginFlowSpec(implicit, { ...readLoginFlowEditor(implicit)!, consent })!;
    const order = saved.nodes.map((node) => node.id);
    expect(order[order.indexOf('authentication') + 1]).toBe(`${SIGN_IN_CONSENT_PREFIX}saml-done`);
    expect(order).toContain(`${SIGN_IN_CONSENT_PREFIX}oidc-done`);
    // Taken out, the order is as it was.
    const back = applyLoginFlowSpec(saved, { ...readLoginFlowEditor(saved)!, consent: [] })!;
    expect(back.nodes.map((node) => node.id)).toEqual(implicit.nodes.map((node) => node.id));
    expect(back.edges).toEqual(implicit.edges);
  });

  it('leaves a consent step rewired in the Flow editor as it is', () => {
    const withConsent = applyLoginFlowSpec(seeded(), {
      ...readLoginFlowEditor(seeded())!,
      consent,
    })!;
    withConsent.edges.push({
      id: 'extra',
      source: `${SIGN_IN_CONSENT_PREFIX}saml-done`,
      source_handle: 'accepted',
      target: 'oidc-done',
    });
    expect(canSetSignInConsent(withConsent)).toBe(false);
    expect(readLoginFlowEditor(withConsent)?.consent).toEqual([]);
  });

  it('leaves consent set differently in the Flow editor as it is', () => {
    const withConsent = applyLoginFlowSpec(seeded(), {
      ...readLoginFlowEditor(seeded())!,
      consent,
    })!;
    const oidc = withConsent.nodes.find(
      (node) => node.id === `${SIGN_IN_CONSENT_PREFIX}oidc-done`
    )!;
    oidc.config = { ...oidc.config, statements: [{ statement_id: 'other', required: true }] };
    expect(canSetSignInConsent(withConsent)).toBe(false);
    const spec = readLoginFlowEditor(withConsent)!;
    expect(spec.consent).toEqual([]);
    // Saving the other settings changes neither step.
    const saved = applyLoginFlowSpec(withConsent, { ...spec, onCancel: 'error' })!;
    expect(saved.nodes.filter((node) => node.type === 'consent')).toEqual(
      withConsent.nodes.filter((node) => node.type === 'consent')
    );
    expect(saved.edges).toEqual(withConsent.edges);
    expect(applyLoginFlowSpec(withConsent, { ...spec, consent })).toBeNull();
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
    expect(applyLoginFlowSpec(open, { ...readLoginFlowEditor(open)!, consent })).toBeNull();
    // Without consent the Flow is still set as before.
    expect(applyLoginFlowSpec(open, readLoginFlowEditor(open)!)).not.toBeNull();
    expect(canSetSignInConsent(seeded())).toBe(true);
  });
});
