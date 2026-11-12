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
}

/** The sign-in a tenant starts from: its own methods and session settings. */
export function defaultLoginFlowSpec(): LoginFlowSpec {
  return {
    profileRef: 'default',
    sessionProfileRef: 'default',
    completion: null,
    unregistered: 'generic',
    onCancel: 'stay',
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
  return {
    profileRef: refOf(config.authentication_profile_ref),
    sessionProfileRef: refOf(config.session_profile_ref),
    completion: completion.ok ? completion.completion : null,
    unregistered: readSignInUnregistered(config.unregistered_signin),
    onCancel: readSignInOnCancel(config.on_cancel),
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
  return copy;
}
