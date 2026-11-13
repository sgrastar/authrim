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
  assertConsentSteps,
  consentStep,
  consentStepConfig,
  hasWhen,
  MAX_FLOW_CONSENT_STEPS,
  readConsentStepStatements,
  readStepWhen,
  stepConditionNode,
  STEP_CONDITION_SHOW,
  STEP_CONDITION_SKIP,
  type FlowConsentStep,
} from './flow-step-condition';
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
   * The consent steps asked before the sign-in completes, in order (empty: none), each to everyone
   * or only to those its conditions hold for. Asked by the console's consent steps
   * (`SIGN_IN_CONSENT_PREFIX`), which leave out what the person has agreed to already and go on by
   * themselves when nothing is left.
   */
  consents: FlowConsentStep[];
}

/** The sign-in a tenant starts from: its own methods and session settings. */
export function defaultLoginFlowSpec(): LoginFlowSpec {
  return {
    profileRef: 'default',
    sessionProfileRef: 'default',
    completion: null,
    unregistered: 'generic',
    onCancel: 'stay',
    consents: [],
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
  return spec.consents.length > 0 ? (withSignInConsent(editor, spec.consents) ?? editor) : editor;
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
  const chains = signInConsentChains(editor as FlowEditorState);
  return {
    profileRef: refOf(config.authentication_profile_ref),
    sessionProfileRef: refOf(config.session_profile_ref),
    completion: completion.ok ? completion.completion : null,
    unregistered: readSignInUnregistered(config.unregistered_signin),
    onCancel: readSignInOnCancel(config.on_cancel),
    // Consent the console cannot set is not shown as its own (saving then leaves it as it is).
    consents: chains && chains.length > 0 ? chains[0] : [],
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
  if (!canSetSignInConsent(copy)) return spec.consents.length > 0 ? null : copy;
  // What the console's steps had beyond what it sets (a screen chosen in the Flow editor, where
  // they were drawn) stays with the step of the same id once they are put back.
  const before = new Map(
    copy.nodes
      .filter((candidate) => managedNode(candidate))
      .map((candidate) => [candidate.id, candidate])
  );
  const without = withoutSignInConsent(copy);
  if (spec.consents.length === 0) return without;
  const rebuilt = withSignInConsent(without, spec.consents);
  for (const node of rebuilt?.nodes ?? []) {
    const old = before.get(node.id);
    if (!old || old.type !== node.type) continue;
    node.config = { ...(old.config ?? {}), ...(node.config ?? {}) };
    if (old.position) node.position = old.position;
    if (old.title) node.title = old.title;
  }
  return rebuilt;
}

/**
 * The consent steps the console puts before a sign-in completes: before each completion, the
 * same steps in the same order, each `sign-in-consent[<k>]-<completion id>` (`k` from the second
 * on), with a condition node `sign-in-when[<k>]-<completion id>` before one shown to some people
 * only. One chain per completion keeps each protocol's way to its completion as it was.
 */
export const SIGN_IN_CONSENT_PREFIX = 'sign-in-consent-';

const MANAGED_NODE = /^sign-in-(consent|when)([2-9]|[1-9][0-9])?-(.+)$/u;

function consentNodeId(k: number, completion: string): string {
  return `sign-in-consent${k === 1 ? '' : k}-${completion}`;
}

function whenNodeId(k: number, completion: string): string {
  return `sign-in-when${k === 1 ? '' : k}-${completion}`;
}

/** A node the console put in a chain: which kind, which step and before which completion. */
function managedNode(node: { id?: unknown; type?: unknown }): { completion: string } | null {
  if (typeof node.id !== 'string') return null;
  const match = MANAGED_NODE.exec(node.id);
  if (!match) return null;
  const type = match[1] === 'consent' ? 'consent' : 'condition';
  return node.type === type ? { completion: match[3] } : null;
}

/**
 * The steps of the chain before a completion, as the console built it, or null when it is not
 * (changed in the Flow editor: a step missing, rewired, asking nothing it can read).
 */
function readChain(state: FlowEditorState, completion: string): FlowConsentStep[] | null {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const outOf = (id: string) => state.edges.filter((edge) => edge.source === id);
  const steps: FlowConsentStep[] = [];
  for (let k = 1; ; k += 1) {
    const consent = byId.get(consentNodeId(k, completion));
    const when = byId.get(whenNodeId(k, completion));
    if (!consent) {
      if (when) return null;
      break;
    }
    if (k > MAX_FLOW_CONSENT_STEPS) return null;
    const statements = readConsentStepStatements(consent);
    const conditions = when ? readStepWhen(when) : null;
    if (!statements || (when && !conditions)) return null;
    steps.push(consentStep(statements, conditions));
  }
  if (steps.length === 0 || byId.get(completion)?.type !== 'complete') return null;
  // Right before its completion in order, as the console puts it: a step without edges of its
  // own goes on to the next one in order, so a chain moved elsewhere in the order could not be
  // put back where it was without changing where such a step goes.
  const order = state.nodes.map((node) => node.id);
  const ids = steps.flatMap((step, index) =>
    hasWhen(step.when)
      ? [whenNodeId(index + 1, completion), consentNodeId(index + 1, completion)]
      : [consentNodeId(index + 1, completion)]
  );
  const at = order.indexOf(completion);
  if (order.slice(at - ids.length, at).join('\n') !== ids.join('\n')) return null;
  const entry = (k: number) =>
    k > steps.length
      ? completion
      : hasWhen(steps[k - 1].when)
        ? whenNodeId(k, completion)
        : consentNodeId(k, completion);
  for (let k = 1; k <= steps.length; k += 1) {
    const next = entry(k + 1);
    const accepted = outOf(consentNodeId(k, completion));
    if (
      accepted.length !== 1 ||
      accepted[0].source_handle !== 'accepted' ||
      accepted[0].target !== next
    ) {
      return null;
    }
    if (hasWhen(steps[k - 1].when)) {
      const out = outOf(whenNodeId(k, completion));
      const to = (handle: string) => out.filter((edge) => edge.source_handle === handle);
      if (
        out.length !== 2 ||
        to(STEP_CONDITION_SHOW)[0]?.target !== consentNodeId(k, completion) ||
        to(STEP_CONDITION_SKIP)[0]?.target !== next
      ) {
        return null;
      }
    }
  }
  return steps;
}

/**
 * The console's chains before the completions (all asking the same), or null when the Flow has
 * some it cannot read as one list. Empty when there are none.
 */
function signInConsentChains(state: FlowEditorState): FlowConsentStep[][] | null {
  if (!signInNode(state)) return null;
  const managed = state.nodes.filter((node) => managedNode(node));
  const completions = [...new Set(managed.map((node) => managedNode(node)!.completion))];
  const chains = completions.map((completion) => readChain(state, completion));
  if (chains.some((chain) => !chain)) return null;
  const read = chains as FlowConsentStep[][];
  // Each node is one of a chain (none left over), and every chain asks the same.
  if (
    read.reduce(
      (sum, chain) => sum + chain.length + chain.filter((step) => hasWhen(step.when)).length,
      0
    ) !== managed.length
  ) {
    return null;
  }
  if (new Set(read.map((chain) => JSON.stringify(chain))).size > 1) return null;
  return read;
}

/** Whether the console can ask for consent before this sign-in Flow completes. */
export function canSetSignInConsent(editor: unknown): boolean {
  if (!signInNode(editor)) return false;
  const state = editor as FlowEditorState;
  const chains = signInConsentChains(state);
  if (!chains) return false;
  if (chains.length > 0) return true;
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
 * The graph (with none of the console's consent steps) with `steps` asked before each completion
 * gone on to: each edge into a completion goes to the first step's way in, each step on to the
 * next, the last to the completion. Null when the Flow has no completion an edge leads to.
 */
function withSignInConsent(
  editor: FlowEditorState,
  steps: readonly FlowConsentStep[]
): FlowEditorState | null {
  assertConsentSteps(steps);
  if (!canSetSignInConsent(editor)) return null;
  const completes = editor.nodes.filter((node) => node.type === 'complete');
  for (const complete of completes) {
    const into = editor.edges.filter((edge) => edge.target === complete.id);
    if (into.length === 0 && !implicitlyReached(editor, complete)) continue;
    const entry = (k: number) =>
      k > steps.length
        ? complete.id
        : hasWhen(steps[k - 1].when)
          ? whenNodeId(k, complete.id)
          : consentNodeId(k, complete.id);
    const x = complete.position?.x ?? 360;
    const y = complete.position?.y ?? ROW;
    const added: FlowEditorNode[] = [];
    steps.forEach((step, index) => {
      const k = index + 1;
      const consent = consentNodeId(k, complete.id);
      const position = { x, y: Math.max(0, y - (ROW / 2) * (steps.length - index)) };
      if (hasWhen(step.when)) {
        const when = whenNodeId(k, complete.id);
        added.push(stepConditionNode(when, step.when, position));
        editor.edges.push(
          {
            id: `${when}:${STEP_CONDITION_SHOW}`,
            source: when,
            source_handle: STEP_CONDITION_SHOW,
            target: consent,
          },
          {
            id: `${when}:${STEP_CONDITION_SKIP}`,
            source: when,
            source_handle: STEP_CONDITION_SKIP,
            target: entry(k + 1),
          }
        );
      }
      added.push({
        id: consent,
        type: 'consent',
        title: 'Consent',
        position,
        config: consentStepConfig(step.statements),
      });
      editor.edges.push({
        id: `${consent}:accepted`,
        source: consent,
        source_handle: 'accepted',
        target: entry(k + 1),
      });
    });
    // Right before the completion in order: a step without edges of its own that went on to the
    // completion (the step after it) goes on to the first step's way in instead.
    editor.nodes.splice(editor.nodes.indexOf(complete), 0, ...added);
    const intoIds = new Set(into);
    editor.edges = editor.edges.map((edge) =>
      intoIds.has(edge) ? { ...edge, target: entry(1) } : edge
    );
  }
  return editor;
}

/** The graph without the console's consent steps: what led into a chain leads to its completion. */
function withoutSignInConsent(editor: FlowEditorState): FlowEditorState {
  const managed = new Set(editor.nodes.filter((node) => managedNode(node)).map((node) => node.id));
  if (managed.size === 0) return editor;
  // Where a chain node goes on to past itself: a consent step once accepted, a condition when skipped.
  const onward = new Map<string, string>();
  for (const edge of editor.edges) {
    if (!managed.has(edge.source)) continue;
    const node = editor.nodes.find((candidate) => candidate.id === edge.source);
    const past = node?.type === 'consent' ? 'accepted' : STEP_CONDITION_SKIP;
    if (edge.source_handle === past) onward.set(edge.source, edge.target);
  }
  const beyond = (id: string): string | undefined => {
    let at: string | undefined = id;
    for (let hops = 0; at && managed.has(at) && hops <= managed.size; hops += 1)
      at = onward.get(at);
    return at && !managed.has(at) ? at : undefined;
  };
  editor.edges = editor.edges
    .filter((edge) => !managed.has(edge.source))
    .flatMap((edge) => {
      if (!managed.has(edge.target)) return [edge];
      const target = beyond(edge.target);
      return target ? [{ ...edge, target }] : [];
    });
  editor.nodes = editor.nodes.filter((node) => !managed.has(node.id));
  return editor;
}
