/**
 * A sign-in Flow as the admin console sets it up, and the Flow graph (`FlowEditorState`) it is
 * saved as.
 *
 * What the console sets lives on the Flow's one sign-in step (the `authentication` node): its
 * authentication method profile, its session profile, and where the person goes once signed in.
 * A sign-in Flow that already exists (the tenant's standard one, or one made in the Flow editor)
 * keeps its graph: saving changes only that step's settings (`applyLoginFlowSpec`). A tenant with
 * none is given a new one (`buildLoginFlowEditor`), shaped as the standard sign-in:
 *
 *   request (entry) ─next→ session-check ─continue→ protocol (condition)
 *                                        ─authenticate→ authentication → protocol
 *   protocol ─saml→ saml-complete (attribute release) / ─oidc→ oidc-complete (authorization),
 *   anything else as oidc-complete
 *
 * A person already signed in goes on (where single sign-on lets the session be used); anyone
 * else signs in with the methods of the step's authentication method profile, and the session
 * is made as its session profile says. The sign-in step has no edges of its own: whichever
 * method is used, the Flow goes on to the step after it.
 */
import type {
  FlowEditorNode,
  FlowEditorState,
  FlowRuntimeJsonObject,
} from '../schemas/flow-runtime';
import {
  readFlowConsentStatements,
  type FlowConsentStatement,
} from '../services/flow-consent-statements';
import { readFlowCompletion, type RegistrationCompletion } from './registration-policy';

/**
 * What a sign-in tells someone whose address has no account: `generic`, the same answer as for
 * one with an account (nobody can find out which addresses have one); `guide`, that there is no
 * account (with a way to sign up where the tenant has one).
 */
export type SignInUnregistered = 'generic' | 'guide';
/**
 * What happens when the person stops the sign-in (or it fails for good): `stay`, they stay on the
 * sign-in page; `error`, they can go back to the app, which is told they did not sign in
 * (OIDC `access_denied`, a SAML failure Response).
 */
export type SignInOnCancel = 'stay' | 'error';

/** A sign-in step's `unregistered_signin`; anything else is the safe `generic`. */
export const readSignInUnregistered = (value: unknown): SignInUnregistered =>
  value === 'guide' ? 'guide' : 'generic';
/** A sign-in step's `on_cancel`; anything else is `stay`. */
export const readSignInOnCancel = (value: unknown): SignInOnCancel =>
  value === 'error' ? 'error' : 'stay';

export interface LoginFlowSpec {
  /** The authentication method profile (`default`: the tenant's methods). */
  profileRef: string;
  /** The session profile (`default`: the tenant's session settings). */
  sessionProfileRef: string;
  /**
   * Where the person goes once signed in, when no application asked for the sign-in (the same
   * choices as a sign-up's). Null: the tenant's post-sign-in destination.
   */
  completion: RegistrationCompletion | null;
  /** What an address without an account is told (`generic` unless set). */
  unregistered: SignInUnregistered;
  /** What stopping the sign-in does (`stay` unless set). */
  onCancel: SignInOnCancel;
  /**
   * The consent statements asked before the sign-in completes, in order (empty: none). Asked by
   * the console's consent steps (`SIGN_IN_CONSENT_PREFIX`), which leave out what the person has
   * agreed to already and go on by themselves when nothing is left.
   */
  consent: FlowConsentStatement[];
}

/** The sign-in a tenant starts from: its own methods and session settings. */
export function defaultLoginFlowSpec(): LoginFlowSpec {
  return {
    profileRef: 'default',
    sessionProfileRef: 'default',
    completion: null,
    unregistered: 'generic',
    onCancel: 'stay',
    consent: [],
  };
}

const ROW = 144;

/** The settings the console owns on the sign-in step, as its config holds them. */
function specConfig(spec: LoginFlowSpec): FlowRuntimeJsonObject {
  return {
    authentication_profile_ref: spec.profileRef || 'default',
    session_profile_ref: spec.sessionProfileRef || 'default',
    // A plain JSON copy: the graph is stored as JSON.
    ...(spec.completion
      ? { completion: JSON.parse(JSON.stringify(spec.completion)) as FlowRuntimeJsonObject }
      : {}),
    // Written only when not the default, so a Flow saved before these existed reads the same.
    ...(spec.unregistered === 'guide' ? { unregistered_signin: 'guide' } : {}),
    ...(spec.onCancel === 'error' ? { on_cancel: 'error' } : {}),
  };
}

function completeNode(id: string, x: number, protocol: 'saml' | 'oidc'): FlowEditorNode {
  return {
    id,
    type: 'complete',
    title: 'Complete',
    position: { x, y: 4 * ROW },
    config: {
      ui_kind: 'end',
      completion_block:
        protocol === 'saml'
          ? {
              id: 'saml-attribute-release-completion',
              label: 'SAML Attribute Release Completion',
              protocol: 'saml',
              purpose: 'attribute_release',
              role: 'output',
            }
          : {
              id: 'oidc-authorization-completion',
              label: 'OIDC Authorization Completion',
              protocol: 'oidc',
              purpose: 'authorization',
              role: 'output',
            },
    },
  };
}

/** The Flow graph of a new sign-in Flow (for a tenant that has none). */
export function buildLoginFlowEditor(spec: LoginFlowSpec): FlowEditorState {
  const editor = baseLoginFlowEditor(spec);
  return spec.consent.length > 0 ? (withSignInConsent(editor, spec.consent) ?? editor) : editor;
}

function baseLoginFlowEditor(spec: LoginFlowSpec): FlowEditorState {
  const at = (index: number, x = 360) => ({ x, y: index * ROW });
  return {
    // In running order: the sign-in step goes on to the step after it, the protocol branch.
    nodes: [
      {
        id: 'request',
        type: 'entry',
        title: 'Sign-in Request',
        position: at(0),
        config: { ui_kind: 'start' },
      },
      {
        id: 'session-check',
        type: 'session_check',
        title: 'Session Check',
        position: at(1),
        config: { ui_kind: 'session' },
      },
      {
        id: 'authentication',
        type: 'authentication',
        title: 'Authentication Method',
        position: at(2, 520),
        config: { ui_kind: 'authentication', screen_ref: 'login', ...specConfig(spec) },
      },
      {
        id: 'protocol',
        type: 'condition',
        title: 'Protocol Branch',
        position: at(3),
        config: {
          ui_kind: 'condition',
          conditions: {
            rows: [
              {
                id: 'saml',
                label: 'SAML',
                condition: { type: 'protocol', value: 'saml' },
                output_handle: 'saml',
              },
              {
                id: 'oidc',
                label: 'OIDC',
                condition: { type: 'protocol', value: 'oidc' },
                output_handle: 'oidc',
              },
            ],
            // A sign-in no application asked for ends as an OIDC one does.
            otherwise: { output_handle: 'oidc' },
          },
        },
      },
      completeNode('saml-complete', 120, 'saml'),
      completeNode('oidc-complete', 600, 'oidc'),
    ],
    edges: [
      {
        id: 'request:next->session-check',
        source: 'request',
        source_handle: 'next',
        target: 'session-check',
      },
      {
        id: 'session-check:continue->protocol',
        source: 'session-check',
        source_handle: 'continue',
        target: 'protocol',
      },
      {
        id: 'session-check:authenticate->authentication',
        source: 'session-check',
        source_handle: 'authenticate',
        target: 'authentication',
      },
      { id: 'protocol:saml', source: 'protocol', source_handle: 'saml', target: 'saml-complete' },
      { id: 'protocol:oidc', source: 'protocol', source_handle: 'oidc', target: 'oidc-complete' },
    ],
    viewport: { x: 36, y: 36, zoom: 1 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const refOf = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : 'default';

/** The Flow's one sign-in step, or null when it has none or more than one. */
function signInNode(editor: unknown): Record<string, unknown> | null {
  if (!isRecord(editor) || !Array.isArray(editor.nodes) || !Array.isArray(editor.edges)) {
    return null;
  }
  const steps = editor.nodes.filter(
    (node): node is Record<string, unknown> => isRecord(node) && node.type === 'authentication'
  );
  return steps.length === 1 ? steps[0] : null;
}

/**
 * What the console sets on a sign-in Flow, read from its one sign-in step; null for a Flow with
 * none or several (the console then shows it, and says it is set up in the Flow editor).
 */
export function readLoginFlowEditor(editor: unknown): LoginFlowSpec | null {
  const node = signInNode(editor);
  if (!node) return null;
  const config = isRecord(node.config) ? node.config : {};
  const completion = readFlowCompletion(config.completion);
  const consentNode = (editor as FlowEditorState).nodes.find(
    (candidate) => isRecord(candidate) && isSignInConsentNode(candidate)
  );
  return {
    profileRef: refOf(config.authentication_profile_ref),
    sessionProfileRef: refOf(config.session_profile_ref),
    completion: completion.ok ? completion.completion : null,
    unregistered: readSignInUnregistered(config.unregistered_signin),
    onCancel: readSignInOnCancel(config.on_cancel),
    // Consent the console cannot set is not shown as its own (saving then leaves it as it is).
    consent:
      consentNode && canSetSignInConsent(editor)
        ? (readFlowConsentStatements(consentNode.config) ?? [])
        : [],
  };
}

/**
 * A sign-in Flow's graph with the console's settings applied to its one sign-in step, and
 * nothing else changed; null for a Flow the console cannot set (`readLoginFlowEditor`).
 */
export function applyLoginFlowSpec(editor: unknown, spec: LoginFlowSpec): FlowEditorState | null {
  const node = signInNode(editor);
  if (!node) return null;
  const copy = JSON.parse(JSON.stringify(editor)) as FlowEditorState;
  const target = copy.nodes.find((candidate) => candidate.id === node.id);
  if (!target) return null;
  const config: FlowRuntimeJsonObject = { ...(target.config ?? {}) };
  delete config.completion;
  delete config.unregistered_signin;
  delete config.on_cancel;
  target.config = { ...config, ...specConfig(spec) };
  // A Flow whose consent the console cannot set keeps its consent as it is.
  if (!canSetSignInConsent(copy)) return spec.consent.length > 0 ? null : copy;
  if (spec.consent.length > 0) return withSignInConsent(copy, spec.consent);
  return withoutSignInConsent(copy);
}

/**
 * The consent steps the console puts before a sign-in completes: one before each completion,
 * `sign-in-consent-<completion id>`, all asking the same statements. One per completion keeps
 * each protocol's way to its completion as it was.
 */
export const SIGN_IN_CONSENT_PREFIX = 'sign-in-consent-';

const isSignInConsentNode = (node: { id?: unknown; type?: unknown }) =>
  typeof node.id === 'string' &&
  node.id.startsWith(SIGN_IN_CONSENT_PREFIX) &&
  node.type === 'consent';

/** Whether the console can ask for consent before this sign-in Flow completes. */
export function canSetSignInConsent(editor: unknown): boolean {
  if (!signInNode(editor)) return false;
  const state = editor as FlowEditorState;
  const managed = state.nodes.filter((node) => isSignInConsentNode(node));
  if (managed.length > 0) {
    // Set elsewhere (in the Flow editor) so the steps ask different things, or something unreadable:
    // the console cannot show it as one list, so it does not change it.
    const lists = managed.map((node) => readFlowConsentStatements(node.config));
    if (lists.some((list) => !list || list.length === 0)) return false;
    if (new Set(lists.map((list) => JSON.stringify(list))).size !== 1) return false;
    // Each step goes on, once accepted, to its own completion and nowhere else (rewired in the Flow
    // editor, taking it out could not put the ways back).
    return managed.every((node) => {
      const out = state.edges.filter((edge) => edge.source === node.id);
      return (
        out.length === 1 &&
        out[0].source_handle === 'accepted' &&
        `${SIGN_IN_CONSENT_PREFIX}${out[0].target}` === node.id &&
        state.nodes.some(
          (candidate) => candidate.id === out[0].target && candidate.type === 'complete'
        )
      );
    });
  }
  return state.nodes.some((node) => node.type === 'complete' && reachesCompletion(state, node));
}

/**
 * Whether a completion is gone on to: by an edge, or as the step after one without edges of its
 * own (a step without edges goes on to the next step in order).
 */
function reachesCompletion(state: FlowEditorState, complete: FlowEditorNode): boolean {
  if (state.edges.some((edge) => edge.target === complete.id)) return true;
  return implicitlyReached(state, complete);
}

function implicitlyReached(state: FlowEditorState, complete: FlowEditorNode): boolean {
  const index = state.nodes.indexOf(complete);
  const before = index > 0 ? state.nodes[index - 1] : null;
  return (
    !!before && before.type !== 'complete' && !state.edges.some((edge) => edge.source === before.id)
  );
}

/**
 * The graph with the console's consent steps asking `statements`: each edge into a completion
 * goes to the consent step before it, which goes on to the completion once accepted. Null when
 * the Flow has no completion an edge leads to (`canSetSignInConsent`).
 */
function withSignInConsent(
  editor: FlowEditorState,
  statements: readonly FlowConsentStatement[]
): FlowEditorState | null {
  if (!canSetSignInConsent(editor)) return null;
  const config = (): FlowRuntimeJsonObject => ({
    ui_kind: 'consent',
    statements: statements.map((entry) => ({
      statement_id: entry.statement_id,
      required: entry.required,
    })),
  });
  // Every edge into a completion goes through that completion's consent step, also an edge drawn
  // since the steps were put in (so no way to a completion leaves the step out).
  const managedIds = new Set(
    editor.nodes.filter((node) => isSignInConsentNode(node)).map((node) => node.id)
  );
  const completes = editor.nodes.filter((node) => node.type === 'complete');
  for (const complete of completes) {
    const id = `${SIGN_IN_CONSENT_PREFIX}${complete.id}`;
    const into = editor.edges.filter(
      (edge) => edge.target === complete.id && !managedIds.has(edge.source)
    );
    // Gone on to only as the step after one without edges: the consent step, put right before it,
    // takes its place in the order.
    if (into.length === 0 && (managedIds.has(id) || !implicitlyReached(editor, complete))) continue;
    if (!managedIds.has(id)) {
      // Right before the completion in order: a step without edges of its own that went on to the
      // completion (the step after it) goes on to the consent step instead.
      editor.nodes.splice(editor.nodes.indexOf(complete), 0, {
        id,
        type: 'consent',
        title: 'Consent',
        position: {
          x: complete.position?.x ?? 360,
          y: Math.max(0, (complete.position?.y ?? ROW) - ROW / 2),
        },
        config: config(),
      });
      editor.edges.push({
        id: `${id}:accepted`,
        source: id,
        source_handle: 'accepted',
        target: complete.id,
      });
      managedIds.add(id);
    }
    const intoIds = new Set(into);
    editor.edges = editor.edges.map((edge) => (intoIds.has(edge) ? { ...edge, target: id } : edge));
  }
  for (const node of editor.nodes) {
    if (isSignInConsentNode(node)) node.config = { ...(node.config ?? {}), ...config() };
  }
  return editor;
}

/** The graph without the console's consent steps: what led to one leads to its completion. */
function withoutSignInConsent(editor: FlowEditorState): FlowEditorState {
  const managed = new Set(
    editor.nodes.filter((node) => isSignInConsentNode(node)).map((node) => node.id)
  );
  if (managed.size === 0) return editor;
  const onward = new Map<string, string>();
  for (const edge of editor.edges) {
    if (managed.has(edge.source) && edge.source_handle === 'accepted') {
      onward.set(edge.source, edge.target);
    }
  }
  editor.edges = editor.edges
    .filter((edge) => !managed.has(edge.source))
    .flatMap((edge) => {
      if (!managed.has(edge.target)) return [edge];
      const target = onward.get(edge.target);
      return target ? [{ ...edge, target }] : [];
    });
  editor.nodes = editor.nodes.filter((node) => !managed.has(node.id));
  return editor;
}
