/**
 * The consent statements a Flow step asks for.
 *
 * A Flow's consent node (and a method selector that asks for consent with the choice) lists the
 * statements it asks for in its config, in the order they are shown:
 *
 * ```json
 * { "statements": [{ "statement_id": "tos", "required": true }, { "statement_id": "news", "required": false }] }
 * ```
 *
 * The current version of each statement is asked. A required statement must be agreed to before
 * the Flow goes on; an optional one may be declined (recorded as declined).
 *
 * A Flow is walked only when someone goes through it. A person who already has a session is
 * answered at `/authorize` (and SAML SSO) without one, so the required statements that any way
 * the request can take through the sign-in Flow asks for are checked there too
 * (`ssoRequiredConsentStatementIds`).
 */
import {
  conditionUserAttributeKeys,
  evaluateFlowCondition,
  runtimeConditionExpressions,
  type FlowConditionEvaluationContext,
  type FlowConditionEvaluationUser,
  type FlowConditionExpression,
  type FlowEditorState,
  type FlowRuntimeContract,
  type FlowRuntimeStep,
} from '../schemas/flow-runtime';

/** A statement a step asks for. */
export interface FlowConsentStatement {
  statement_id: string;
  required: boolean;
}

/** The most statements one step may ask for. */
export const MAX_FLOW_CONSENT_STATEMENTS = 50;

const STATEMENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The statements in a step's config, or null when it lists none or the list is malformed (an
 * entry without a usable id, a non-boolean `required`, a repeated statement, or too many).
 */
export function readFlowConsentStatements(config: unknown): FlowConsentStatement[] | null {
  if (!isRecord(config) || !Array.isArray(config.statements)) return null;
  const list = config.statements;
  if (list.length > MAX_FLOW_CONSENT_STATEMENTS) return null;
  const seen = new Set<string>();
  const statements: FlowConsentStatement[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) return null;
    const id = entry.statement_id;
    if (typeof id !== 'string' || !STATEMENT_ID.test(id) || seen.has(id)) return null;
    if (entry.required !== undefined && typeof entry.required !== 'boolean') return null;
    seen.add(id);
    statements.push({ statement_id: id, required: entry.required === true });
  }
  return statements;
}

/** Whether the step lists statements to ask for (an empty list asks for none). */
export function stepAsksForConsent(step: Pick<FlowRuntimeStep, 'config'>): boolean {
  return (readFlowConsentStatements(step.config)?.length ?? 0) > 0;
}

function trimmed(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

/**
 * The protocol a step's completion answers, if it names one (`config.completion_block.protocol`),
 * read as the runtime reads it: a block without a usable id names no protocol.
 */
function stepProtocol(step: FlowRuntimeStep | undefined): string | null {
  const block = isRecord(step?.config) ? step.config.completion_block : undefined;
  if (!isRecord(block) || !trimmed(block.id, 200)) return null;
  return trimmed(block.protocol, 64);
}

/** The protocol of a request that is answered at single sign-on. */
export type FlowSsoProtocol = 'oidc' | 'saml';

/** The attributes of the person signing in, by key (only the keys asked for need be there). */
export type FlowSsoUserAttributes = NonNullable<FlowConditionEvaluationUser['attributes']>;

/** What is known of a request answered at single sign-on, before any Flow runs. */
export interface FlowSsoContext {
  protocol: FlowSsoProtocol;
  client_id?: string;
  saml_sp_id?: string;
  /**
   * Reads the signed-in person's attributes (the keys the Flow's conditions read), so a condition
   * on a user attribute or an age is judged for them. Called once, only when a condition reads
   * one. Without it, or when it fails, such a condition may go either way.
   */
  user_attributes?: (keys: string[]) => Promise<FlowSsoUserAttributes>;
  /** When the conditions are judged (an age is the age on this day); now when absent. */
  now_ms?: number;
}

/** Condition kinds judged from the person signing in, when their attributes can be read. */
const USER_CONDITION_TYPES = new Set(['user.attribute', 'user.age']);

/** What a walk knows: the request, and the person's attributes once read (null: unreadable). */
interface SsoKnowledge {
  context: FlowSsoContext;
  known: FlowConditionEvaluationContext;
  user: () => Promise<FlowSsoUserAttributes | null>;
}

function ssoKnowledge(runtime: FlowRuntimeContract, context: FlowSsoContext): SsoKnowledge {
  const known: FlowConditionEvaluationContext = {
    protocol: context.protocol,
    flow_kind: 'login',
    ...(context.client_id ? { client_id: context.client_id } : {}),
    ...(context.saml_sp_id ? { saml_sp_id: context.saml_sp_id } : {}),
    ...(context.now_ms !== undefined ? { now_ms: context.now_ms } : {}),
  };
  let read: Promise<FlowSsoUserAttributes | null> | null = null;
  const user = () => {
    if (!context.user_attributes) return Promise.resolve(null);
    read ??= (async () => {
      const keys = conditionUserAttributeKeys(runtimeConditionExpressions(runtime));
      if (keys.length === 0) return {};
      try {
        return await (context.user_attributes as NonNullable<FlowSsoContext['user_attributes']>)(
          keys
        );
      } catch {
        // Not read: such a condition may go either way (asking once more is the safer way).
        return null;
      }
    })();
    return read;
  };
  return { context, known, user };
}

/**
 * Whether a condition holds for this request: true or false when it can be judged from the request
 * (or the person's attributes), null when it depends on the run. An `all` holds when each of its
 * conditions does, does not when any one is judged not to, and is unknown otherwise.
 */
async function judgeCondition(
  condition: Record<string, unknown>,
  knowledge: SsoKnowledge
): Promise<boolean | null> {
  const { context, known } = knowledge;
  const type = condition.type;
  if (type === 'all') {
    if (!Array.isArray(condition.all) || condition.all.length === 0) return false;
    let unknown = false;
    for (const member of condition.all) {
      if (!isRecord(member) || member.type === 'all') return false;
      const result = await judgeCondition(member, knowledge);
      if (result === false) return false;
      if (result === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (typeof type !== 'string') return null;
  if (USER_CONDITION_TYPES.has(type)) {
    const attributes = await knowledge.user();
    if (!attributes) return null;
    return evaluateFlowCondition(condition as unknown as FlowConditionExpression, {
      ...known,
      user: { attributes },
    });
  }
  // An app id condition is judged when the request's id is known, or when the request has none
  // of that kind (an OIDC request has no SAML SP, a SAML one no client): it does not match then.
  const judged =
    KNOWN_CONDITION_TYPES.has(type) &&
    !(type === 'client_id' && context.protocol === 'oidc' && !known.client_id) &&
    !(type === 'saml_sp_id' && context.protocol === 'saml' && !known.saml_sp_id);
  if (!judged) return null;
  return evaluateFlowCondition(condition as unknown as FlowConditionExpression, known);
}

/** Condition kinds judged from the request alone (the others depend on the run). */
const KNOWN_CONDITION_TYPES = new Set([
  'always',
  'protocol',
  'client_id',
  'saml_sp_id',
  'flow_kind',
]);

/**
 * The handles a condition step can take for this request: rows are tried in order, as the runtime
 * does; a row judged from the request is followed (and ends the search) or skipped, one that
 * cannot be judged may be taken either way. Null when the step is not a readable condition (every
 * handle can be taken).
 */
async function conditionHandles(
  step: FlowRuntimeStep,
  knowledge: SsoKnowledge | null
): Promise<Set<string> | null> {
  if (step.component !== 'condition' || !knowledge || !isRecord(step.config)) return null;
  const conditions = step.config.conditions;
  if (!isRecord(conditions) || !Array.isArray(conditions.rows)) return null;
  const handles = new Set<string>();
  for (const row of conditions.rows) {
    if (!isRecord(row) || !isRecord(row.condition) || typeof row.output_handle !== 'string') {
      return null;
    }
    const holds = await judgeCondition(row.condition, knowledge);
    if (holds === null) {
      handles.add(row.output_handle);
      continue;
    }
    if (holds) {
      handles.add(row.output_handle);
      return handles;
    }
  }
  const otherwise = isRecord(conditions.otherwise) ? conditions.otherwise.output_handle : undefined;
  if (typeof otherwise === 'string') handles.add(otherwise);
  return handles;
}

async function successorsOf(
  runtime: FlowRuntimeContract,
  editor: Pick<FlowEditorState, 'edges'> | null,
  index: number,
  knowledge: SsoKnowledge | null
): Promise<number[]> {
  const step = runtime.ui.steps[index];
  if (!step) return [];
  // As the runtime walks it: the node's edges, or the next step when it has none.
  const edges = (editor?.edges ?? []).filter((edge) => edge.source === step.source_node_id);
  if (edges.length === 0) return index + 1 < runtime.ui.steps.length ? [index + 1] : [];
  const indexOf = (target: string) =>
    runtime.ui.steps.findIndex((candidate) => candidate.source_node_id === target);
  // Every handle may be taken, except those a condition judged from the request rules out.
  const reachable = await conditionHandles(step, knowledge);
  // The runtime picks among the edges of the handle it was sent (exactly that handle), or, sent
  // none, among the default edges (unlabeled or `next`). Each such set is taken into account.
  const groups: (typeof edges)[] = [];
  const byHandle = new Map<string, typeof edges>();
  for (const edge of edges) {
    if (!edge.source_handle) continue;
    byHandle.set(edge.source_handle, [...(byHandle.get(edge.source_handle) ?? []), edge]);
  }
  for (const [handle, group] of byHandle) {
    if (!reachable || reachable.has(handle)) groups.push(group);
  }
  const defaults = edges.filter((edge) => !edge.source_handle || edge.source_handle === 'next');
  if (defaults.length > 0 && (!reachable || reachable.has('next'))) groups.push(defaults);
  const protocol = knowledge?.context.protocol ?? null;
  const targets: number[] = [];
  for (const group of groups) {
    // Among a set the runtime prefers a target that answers the request's protocol (or names
    // none). Every such target is kept; when there is none, every edge is.
    const answering = protocol
      ? group.filter((edge) => {
          const target = stepProtocol(runtime.ui.steps[indexOf(edge.target)]);
          return !target || target === protocol;
        })
      : [];
    for (const edge of answering.length > 0 ? answering : group) {
      const target = indexOf(edge.target);
      if (target >= 0 && !targets.includes(target)) targets.push(target);
    }
  }
  return targets;
}

/** The steps a request can reach from the first one, in no particular order. */
async function reachableSteps(
  runtime: FlowRuntimeContract,
  editor: Pick<FlowEditorState, 'edges'> | null,
  context: FlowSsoContext | null
): Promise<Set<number>> {
  const knowledge = context ? ssoKnowledge(runtime, context) : null;
  const seen = new Set<number>();
  if (runtime.ui.steps.length === 0) return seen;
  seen.add(0);
  const queue = [0];
  while (queue.length > 0) {
    const index = queue.shift() as number;
    if (runtime.ui.steps[index]?.component === 'completion') continue;
    for (const target of await successorsOf(runtime, editor, index, knowledge)) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

/**
 * The required statements a person who is answered without going through the Flow (single
 * sign-on) must have agreed to, in the order the steps come: those of every step the request can
 * reach. Only what is certain from the request narrows the ways: its protocol picks among edges
 * made for a protocol, and conditions judged from the request (protocol, app, Flow kind), or from
 * the signed-in person's attributes when they can be read (a user attribute, an age), pick their
 * branch. Everything else (a condition on the run, a screen's exits, an action's outcome)
 * may go either way, so a required statement on any of those ways is required here: asking once
 * more is better than letting someone past a statement their way would have asked for.
 */
export async function ssoRequiredConsentStatementIds(
  runtime: FlowRuntimeContract,
  editor: Pick<FlowEditorState, 'edges'> | null,
  context: FlowSsoContext | null = null
): Promise<string[]> {
  const reachable = await reachableSteps(runtime, editor, context);
  const ids: string[] = [];
  for (const [index, step] of runtime.ui.steps.entries()) {
    if (!reachable.has(index)) continue;
    for (const statement of readFlowConsentStatements(step.config) ?? []) {
      if (statement.required && !ids.includes(statement.statement_id)) {
        ids.push(statement.statement_id);
      }
    }
  }
  return ids;
}
