/**
 * A sign-up Flow as the admin console sets it up, and the Flow graph (`FlowEditorState`) it is
 * saved and published as. Both ways: the console saves a spec as a graph, reads a graph it made
 * back into a spec, and a new tenant is given the default spec's graph.
 *
 * The graph, in running order (one runtime step per node, in this order):
 *
 *   request (entry) ─next→ registration (method choice, on the first screen; its policy and
 *   profile in its config) → [email-check (email_verification), when the address is checked
 *   before the account is final] → screen-1 … screen-n (more screens) → account-create
 *   (account_action) ─completed→ output (complete)
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
import {
  readFlowConsentStatements,
  type FlowConsentStatement,
} from '../services/flow-consent-statements';
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
   * The consent statements asked on the first screen, with the method choice, in order (empty:
   * none). Everyone signing up is new, so each is asked; the answers are recorded once the
   * account exists.
   */
  consent: FlowConsentStatement[];
}

/** The sign-up a new tenant is given: its built-in screen, its own methods, the safer policy. */
export function defaultRegistrationFlowSpec(): RegistrationFlowSpec {
  return {
    profileRef: 'default',
    sessionProfileRef: 'default',
    screenKey: 'registration',
    screens: [],
    policy: structuredClone(DEFAULT_REGISTRATION_POLICY),
    consent: [],
  };
}

const ROW = 144;
const SCREEN_NODE = /^screen-([1-9][0-9]{0,2})$/u;
const EXIT_HANDLE = /^[a-z][a-z0-9_]{0,39}$/u;

function screenNodeId(n: number): string {
  return `screen-${n}`;
}

/** The consent step a sign-up asks its statements on, right before the account is made. */
export const REGISTRATION_CONSENT_NODE = 'consent';

function targetNodeId(
  target: string,
  screens: readonly RegistrationFlowScreen[],
  finish = 'account-create'
): string | null {
  if (target === 'complete') return finish;
  const match = /^screen:([1-9][0-9]{0,2})$/u.exec(target);
  if (!match) return null;
  const n = Number(match[1]);
  return screens.some((screen) => screen.n === n) ? screenNodeId(n) : null;
}

/** The Flow graph a spec is saved as. */
export function buildRegistrationFlowEditor(spec: RegistrationFlowSpec): FlowEditorState {
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
  for (const screen of screens) {
    nodes.push({
      id: screenNodeId(screen.n),
      type: 'screen',
      title: screen.title ?? `Screen ${screen.n + 1}`,
      position: at(nodes.length),
      config: { screen_ref: screen.screenKey },
    });
  }
  const asksConsent = spec.consent.length > 0;
  // Its own step (every screen can show it), before the account is made: what is agreed to is
  // held until then and recorded with the account.
  if (asksConsent) {
    nodes.push({
      id: REGISTRATION_CONSENT_NODE,
      type: 'consent',
      title: 'Consent',
      position: at(nodes.length),
      config: {
        ui_kind: 'consent',
        statements: spec.consent.map((entry) => ({
          statement_id: entry.statement_id,
          required: entry.required,
        })),
      },
    });
  }
  const finish = asksConsent ? REGISTRATION_CONSENT_NODE : 'account-create';
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
  const after = (id: string) => {
    const index = nodes.findIndex((node) => node.id === id);
    return nodes[index + 1]?.id ?? 'output';
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
    // Its submit goes on to the next step unless the spec sends it elsewhere.
    const submittedTo =
      (screen.exits.submitted ? targetNodeId(screen.exits.submitted, screens, finish) : null) ??
      after(id);
    edges.push({
      id: `${id}:submitted`,
      source: id,
      source_handle: 'submitted',
      target: submittedTo === id ? after(id) : submittedTo,
    });
    for (const [exit, target] of Object.entries(screen.exits)) {
      if (exit === 'submitted' || !(exit === 'skipped' || EXIT_HANDLE.test(exit))) continue;
      const node = targetNodeId(target, screens, finish);
      if (!node || node === id) continue;
      edges.push({ id: `${id}:${exit}`, source: id, source_handle: exit, target: node });
    }
  }
  if (asksConsent) {
    edges.push({
      id: `${REGISTRATION_CONSENT_NODE}:accepted`,
      source: REGISTRATION_CONSENT_NODE,
      source_handle: 'accepted',
      target: 'account-create',
    });
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
  const screens: RegistrationFlowScreen[] = [];
  const nextNodeOf = (id: unknown) => {
    const index = nodes.findIndex((node) => node.id === id);
    return index >= 0 ? nodes[index + 1]?.id : undefined;
  };
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
      const target =
        edge.target === 'account-create' || edge.target === REGISTRATION_CONSENT_NODE
          ? 'complete'
          : typeof edge.target === 'string' && SCREEN_NODE.test(edge.target)
            ? `screen:${edge.target.slice('screen-'.length)}`
            : null;
      if (target) exits[edge.source_handle] = target;
    }
    screens.push({
      n,
      screenKey: key,
      ...(typeof node.title === 'string' && node.title !== `Screen ${n + 1}`
        ? { title: node.title }
        : {}),
      exits,
    });
  }
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
    consent: (() => {
      const step = nodes.find(
        (node) => node.id === REGISTRATION_CONSENT_NODE && node.type === 'consent'
      );
      return step ? (readFlowConsentStatements(step.config) ?? []) : [];
    })(),
  };
}
