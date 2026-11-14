/**
 * A sign-up Flow as the admin console sets it up, and the Flow graph (`FlowEditorState`) it is
 * saved and published as. Both ways: the console saves a spec as a graph, reads a graph it made
 * back into a spec, and a new tenant is given the default spec's graph.
 *
 * The graph, in running order (one runtime step per node, in this order):
 *
 *   request (entry) ─next→ registration (method choice, on the first screen; its policy and
 *   profile in its config) → [email-check (email_verification), when the address is checked
 *   before the account is final] → screen-1 … screen-n (more screens) → consent, consent-2 …
 *   (consent steps) → account-create (account_action) ─completed→ output (complete)
 *
 * A more screen or a consent step shown only to some people has a condition node right before it
 * (`when-<step>`, see flow-step-condition.ts): it goes on to the step when its conditions hold,
 * and to the step after it when they do not. Every way into the step goes through it.
 *
 * The registration step has no edges of its own: whichever method the person signs up with
 * (the tenant's, narrowed by the profile, may change after publishing), the Flow goes on to the
 * step after it. Each more screen has an edge for its submit, and one for each of its exits the
 * spec gives a place; an exit with none follows the submit at runtime.
 */
import type {
  FlowEditorEdge,
  FlowEditorNode,
  FlowEditorState,
  FlowRuntimeJsonObject,
} from '../schemas/flow-runtime';
import { readFlowConsentStatements } from '../services/flow-consent-statements';
import {
  assertConsentSteps,
  consentStep,
  consentStepConfig,
  hasWhen,
  readStepWhen,
  stepConditionNode,
  STEP_CONDITION_SHOW,
  STEP_CONDITION_SKIP,
  type FlowConsentStep,
  type FlowStepWhen,
} from './flow-step-condition';
import {
  DEFAULT_REGISTRATION_POLICY,
  readRegistrationPolicy,
  type RegistrationPolicy,
} from './registration-policy';

/** A screen shown after the first, and where its exits lead (`target`: a step of the spec). */
export interface RegistrationFlowScreen {
  /** Its number among the more screens (stable: the node id is `screen-<n>`). */
  n: number;
  /** The screen's key (`screen_ref`). */
  screenKey: string;
  title?: string;
  /** Exit handle → `screen:<n>` (another more screen) or `complete`. Unlisted: as the submit. */
  exits: Record<string, string>;
  /** Shown only when these all hold (absent: to everyone). */
  when?: FlowStepWhen;
}

export interface RegistrationFlowSpec {
  /** The authentication method profile (`default`: the tenant's methods). */
  profileRef: string;
  /** The session profile the new account's session is made with (`default`: the tenant's). */
  sessionProfileRef: string;
  /** The first screen: the one the method is chosen on. */
  screenKey: string;
  screenTitle?: string;
  screens: RegistrationFlowScreen[];
  policy: RegistrationPolicy;
  /**
   * The consent steps asked before the account is made, in order (empty: none), each to everyone
   * or only to those its conditions hold for. What is agreed to is held until then and recorded
   * with the account.
   */
  consents: FlowConsentStep[];
}

/** The sign-up a new tenant is given: its built-in screen, its own methods, the safer policy. */
export function defaultRegistrationFlowSpec(): RegistrationFlowSpec {
  return {
    profileRef: 'default',
    sessionProfileRef: 'default',
    screenKey: 'registration',
    screens: [],
    policy: structuredClone(DEFAULT_REGISTRATION_POLICY),
    consents: [],
  };
}

const ROW = 144;
const SCREEN_NODE = /^screen-([1-9][0-9]{0,2})$/u;
const EXIT_HANDLE = /^[a-z][a-z0-9_]{0,39}$/u;

function screenNodeId(n: number): string {
  return `screen-${n}`;
}

/** The first consent step a sign-up asks, before the account is made (the others: `consent-<k>`). */
export const REGISTRATION_CONSENT_NODE = 'consent';
const CONSENT_NODE = /^consent(?:-([2-9]|[1-9][0-9]))?$/u;

/** The node of the `k`th consent step (from 1). */
function consentNodeId(k: number): string {
  return k === 1 ? REGISTRATION_CONSENT_NODE : `${REGISTRATION_CONSENT_NODE}-${k}`;
}

/** The condition node before a step shown only to some people. */
function whenNodeId(stepId: string): string {
  return `when-${stepId}`;
}

/** The Flow graph a spec is saved as. */
export function buildRegistrationFlowEditor(spec: RegistrationFlowSpec): FlowEditorState {
  assertConsentSteps(spec.consents);
  const screens = [...spec.screens].sort((a, b) => a.n - b.n);
  const nodes: FlowEditorNode[] = [];
  const at = (index: number) => ({ x: 360, y: index * ROW });
  nodes.push({
    id: 'request',
    type: 'entry',
    title: 'Registration Request',
    position: at(0),
    config: { ui_kind: 'start' },
  });
  nodes.push({
    id: 'registration',
    type: 'registration',
    title: spec.screenTitle ?? 'Registration Method',
    position: at(1),
    config: {
      ui_kind: 'registration',
      authentication_profile_ref: spec.profileRef || 'default',
      session_profile_ref: spec.sessionProfileRef || 'default',
      screen_ref: spec.screenKey,
      // A plain JSON copy: the graph is stored as JSON.
      registration_policy: JSON.parse(JSON.stringify(spec.policy)) as FlowRuntimeJsonObject,
    },
  });
  const checksFirst = spec.policy.email_check === 'before';
  if (checksFirst) {
    nodes.push({
      id: 'email-check',
      type: 'email_verification',
      title: 'Email Check',
      position: at(nodes.length),
      config: {},
    });
  }
  // Where each step is gone into: its condition node when it has one, else the step itself.
  const entryOf = new Map<string, string>();
  const conditional: Array<{ step: string; when: FlowStepWhen }> = [];
  const push = (node: Omit<FlowEditorNode, 'position'>, when: FlowStepWhen | undefined) => {
    if (hasWhen(when)) {
      const id = whenNodeId(node.id);
      nodes.push(stepConditionNode(id, when, at(nodes.length)));
      entryOf.set(node.id, id);
      conditional.push({ step: node.id, when });
    } else {
      entryOf.set(node.id, node.id);
    }
    nodes.push({ ...node, position: at(nodes.length) });
  };
  for (const screen of screens) {
    push(
      {
        id: screenNodeId(screen.n),
        type: 'screen',
        title: screen.title ?? `Screen ${screen.n + 1}`,
        config: { screen_ref: screen.screenKey },
      },
      screen.when
    );
  }
  // Each its own step (every screen can show it), before the account is made: what is agreed to
  // is held until then and recorded with the account.
  const consents = spec.consents.map((step, index) => ({ id: consentNodeId(index + 1), step }));
  for (const { id, step } of consents) {
    push(
      { id, type: 'consent', title: 'Consent', config: consentStepConfig(step.statements) },
      step.when
    );
  }
  const finish = consents.length > 0 ? (entryOf.get(consents[0].id) as string) : 'account-create';
  nodes.push({
    id: 'account-create',
    type: 'account_action',
    title: 'Account Creation',
    position: at(nodes.length),
    config: { ui_kind: 'account' },
  });
  nodes.push({
    id: 'output',
    type: 'complete',
    title: 'Complete',
    position: at(nodes.length),
    config: { ui_kind: 'end' },
  });

  const edges: FlowEditorEdge[] = [
    {
      id: 'request:next->registration',
      source: 'request',
      source_handle: 'next',
      target: 'registration',
    },
  ];
  // The way into the step after a node (its condition node when it has one).
  const after = (id: string) => {
    const index = nodes.findIndex((node) => node.id === id);
    return nodes[index + 1]?.id ?? 'output';
  };
  const targetOf = (target: string): string | null => {
    if (target === 'complete') return finish;
    const match = /^screen:([1-9][0-9]{0,2})$/u.exec(target);
    if (!match) return null;
    return entryOf.get(screenNodeId(Number(match[1]))) ?? null;
  };
  if (checksFirst) {
    // Only a proven address goes on; `failed` has no way out.
    edges.push({
      id: 'email-check:verified',
      source: 'email-check',
      source_handle: 'verified',
      target: after('email-check'),
    });
  }
  for (const screen of screens) {
    const id = screenNodeId(screen.n);
    const self = new Set([id, entryOf.get(id)]);
    // Its submit goes on to the next step unless the spec sends it elsewhere.
    const sent = screen.exits.submitted ? targetOf(screen.exits.submitted) : null;
    edges.push({
      id: `${id}:submitted`,
      source: id,
      source_handle: 'submitted',
      target: sent && !self.has(sent) ? sent : after(id),
    });
    for (const [exit, target] of Object.entries(screen.exits)) {
      if (exit === 'submitted' || !(exit === 'skipped' || EXIT_HANDLE.test(exit))) continue;
      const node = targetOf(target);
      if (!node || self.has(node)) continue;
      edges.push({ id: `${id}:${exit}`, source: id, source_handle: exit, target: node });
    }
  }
  for (const { id } of consents) {
    edges.push({ id: `${id}:accepted`, source: id, source_handle: 'accepted', target: after(id) });
  }
  for (const { step } of conditional) {
    const id = whenNodeId(step);
    edges.push(
      {
        id: `${id}:${STEP_CONDITION_SHOW}`,
        source: id,
        source_handle: STEP_CONDITION_SHOW,
        target: step,
      },
      {
        id: `${id}:${STEP_CONDITION_SKIP}`,
        source: id,
        source_handle: STEP_CONDITION_SKIP,
        target: after(step),
      }
    );
  }
  edges.push({
    id: 'account-create:completed->output',
    source: 'account-create',
    source_handle: 'completed',
    target: 'output',
  });
  return { nodes, edges, viewport: { x: 36, y: 36, zoom: 1 } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The spec a graph was built from (`buildRegistrationFlowEditor`), or null for a graph of
 * another shape (made by hand in the Flow editor, or an older seeded Flow): the console then
 * shows it as it can and says it was not set up here.
 */
export function readRegistrationFlowEditor(editor: unknown): RegistrationFlowSpec | null {
  if (!isRecord(editor) || !Array.isArray(editor.nodes) || !Array.isArray(editor.edges)) {
    return null;
  }
  const nodes = editor.nodes.filter(isRecord);
  const registration = nodes.find((node) => node.type === 'registration');
  if (!registration || !isRecord(registration.config)) return null;
  const config = registration.config;
  const screenKey = typeof config.screen_ref === 'string' ? config.screen_ref : '';
  if (!screenKey) return null;
  const policyRead = readRegistrationPolicy(config.registration_policy);
  const nextNodeOf = (id: unknown) => {
    const index = nodes.findIndex((node) => node.id === id);
    return index >= 0 ? nodes[index + 1]?.id : undefined;
  };
  // The conditions a step is shown on: none without a condition node before it; null (not the
  // console's) when it has one of another shape.
  let unreadable = false;
  const whenOf = (stepId: string): FlowStepWhen | undefined => {
    const node = nodes.find((candidate) => candidate.id === whenNodeId(stepId));
    if (!node) return undefined;
    const when = readStepWhen(node);
    if (!when) unreadable = true;
    return when ?? undefined;
  };
  /** What an exit leads to: another more screen, or on to the consent steps and the account. */
  const exitTarget = (target: unknown): string | null => {
    if (typeof target !== 'string') return null;
    const step = target.startsWith('when-') ? target.slice('when-'.length) : target;
    if (step === 'account-create' || CONSENT_NODE.test(step)) return 'complete';
    return SCREEN_NODE.test(step) ? `screen:${step.slice('screen-'.length)}` : null;
  };
  const screens: RegistrationFlowScreen[] = [];
  for (const node of nodes) {
    const match = typeof node.id === 'string' ? SCREEN_NODE.exec(node.id) : null;
    if (!match || node.type !== 'screen' || !isRecord(node.config)) continue;
    const key = node.config.screen_ref;
    if (typeof key !== 'string' || !key) continue;
    const n = Number(match[1]);
    const exits: Record<string, string> = {};
    for (const edge of editor.edges.filter(isRecord)) {
      if (edge.source !== node.id || typeof edge.source_handle !== 'string') continue;
      // The submit is kept only where it leaves the order (see `buildRegistrationFlowEditor`).
      if (edge.source_handle === 'submitted' && edge.target === nextNodeOf(node.id)) continue;
      const target = exitTarget(edge.target);
      if (target) exits[edge.source_handle] = target;
    }
    const when = whenOf(match[0]);
    screens.push({
      n,
      screenKey: key,
      ...(typeof node.title === 'string' && node.title !== `Screen ${n + 1}`
        ? { title: node.title }
        : {}),
      exits,
      ...(when ? { when } : {}),
    });
  }
  const consents = nodes
    .filter(
      (node) => typeof node.id === 'string' && CONSENT_NODE.test(node.id) && node.type === 'consent'
    )
    .map((node) => {
      const id = node.id as string;
      const k =
        id === REGISTRATION_CONSENT_NODE
          ? 1
          : Number(id.slice(`${REGISTRATION_CONSENT_NODE}-`.length));
      return {
        k,
        step: consentStep(readFlowConsentStatements(node.config) ?? [], whenOf(id) ?? null),
      };
    })
    .sort((a, b) => a.k - b.k);
  if (unreadable) return null;
  return {
    profileRef:
      typeof config.authentication_profile_ref === 'string' && config.authentication_profile_ref
        ? config.authentication_profile_ref
        : 'default',
    sessionProfileRef:
      typeof config.session_profile_ref === 'string' && config.session_profile_ref.trim()
        ? config.session_profile_ref.trim()
        : 'default',
    screenKey,
    ...(typeof registration.title === 'string' && registration.title !== 'Registration Method'
      ? { screenTitle: registration.title }
      : {}),
    screens: screens.sort((a, b) => a.n - b.n),
    policy: policyRead.ok ? policyRead.policy : structuredClone(DEFAULT_REGISTRATION_POLICY),
    consents: consents.map(({ step }) => step),
  };
}
