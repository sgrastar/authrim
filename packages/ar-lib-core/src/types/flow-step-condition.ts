/**
 * A step the admin console shows only to some people, and the consent steps it asks, as the Flow
 * graph holds them.
 *
 * A step with a condition (`when`: conditions that must all hold) has a condition node right
 * before it: the node goes on to the step when they hold (`show`), and past it, to the step after
 * it, when they do not (`skip`). Every way into the step goes through the node, so no way shows it
 * to someone the condition leaves out.
 */
import {
  MAX_FLOW_CONDITION_AGE,
  MAX_FLOW_CONDITION_ALL,
  MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH,
  MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH,
  type FlowConditionExpression,
  type FlowConditionOperator,
  type FlowEditorNode,
  type FlowRuntimeJsonObject,
} from '../schemas/flow-runtime';
import { isOrderableConditionValue } from '../schemas/flow-runtime/condition-operators';
import {
  readFlowConsentStatements,
  type FlowConsentStatement,
} from '../services/flow-consent-statements';

// What the admin console needs to build a step's conditions, from this one module.
export type { FlowConditionExpression, FlowConditionOperator };
export {
  isOrderableConditionValue,
  MAX_FLOW_CONDITION_AGE,
  MAX_FLOW_CONDITION_ALL,
  MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH,
  MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH,
};

/** The standard profile claims a condition may compare (the address by its parts). */
export const FLOW_CONDITION_PROFILE_ATTRIBUTES = [
  'birthdate',
  'gender',
  'locale',
  'zoneinfo',
  'address.country',
  'address.region',
] as const;

/** The conditions a step is shown on, all of which must hold (empty or absent: everyone). */
export type FlowStepWhen = FlowConditionExpression[];

/** One consent step the console asks: its statements, and who it is asked of. */
export interface FlowConsentStep {
  statements: FlowConsentStatement[];
  when?: FlowStepWhen;
}

/** The most consent steps a console Flow asks (each of up to 50 statements). */
export const MAX_FLOW_CONSENT_STEPS = 5;

/** Refuses more consent steps than a console Flow asks (it could not read them back). */
export function assertConsentSteps(steps: readonly FlowConsentStep[]): void {
  if (steps.length > MAX_FLOW_CONSENT_STEPS) throw new Error('too_many_consent_steps');
}

/** The handle a step's condition node takes when its conditions hold, and the one it skips by. */
export const STEP_CONDITION_SHOW = 'show';
export const STEP_CONDITION_SKIP = 'skip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a step is shown to some people only. */
export function hasWhen(when: FlowStepWhen | undefined): when is FlowStepWhen {
  return Array.isArray(when) && when.length > 0;
}

/** The config of the condition node before a step shown on `when`. */
export function stepConditionConfig(when: FlowStepWhen): FlowRuntimeJsonObject {
  const condition: FlowConditionExpression =
    when.length === 1 ? when[0] : { type: 'all', all: when };
  return {
    ui_kind: 'condition',
    conditions: {
      rows: [
        {
          id: STEP_CONDITION_SHOW,
          label: 'Shown',
          // A plain JSON copy: the graph is stored as JSON.
          condition: JSON.parse(JSON.stringify(condition)) as FlowRuntimeJsonObject,
          output_handle: STEP_CONDITION_SHOW,
        },
      ],
      otherwise: { output_handle: STEP_CONDITION_SKIP },
    },
  };
}

/** The condition node before a step. */
export function stepConditionNode(
  id: string,
  when: FlowStepWhen,
  position: { x: number; y: number }
): FlowEditorNode {
  return { id, type: 'condition', title: 'Condition', position, config: stepConditionConfig(when) };
}

/**
 * The conditions a step's condition node shows it on, or null for a node of another shape (one
 * changed in the Flow editor).
 */
export function readStepWhen(node: unknown): FlowStepWhen | null {
  if (!isRecord(node) || node.type !== 'condition' || !isRecord(node.config)) return null;
  const conditions = node.config.conditions;
  if (!isRecord(conditions) || !Array.isArray(conditions.rows) || conditions.rows.length !== 1) {
    return null;
  }
  const row: unknown = conditions.rows[0];
  const otherwise = conditions.otherwise;
  if (
    !isRecord(row) ||
    row.output_handle !== STEP_CONDITION_SHOW ||
    !isRecord(row.condition) ||
    !isRecord(otherwise) ||
    otherwise.output_handle !== STEP_CONDITION_SKIP
  ) {
    return null;
  }
  const condition = row.condition as unknown as FlowConditionExpression;
  if (condition.type !== 'all') return [condition];
  return Array.isArray(condition.all) && condition.all.length > 0 ? condition.all : null;
}

/** A consent node's config asking `statements`. */
export function consentStepConfig(
  statements: readonly FlowConsentStatement[]
): FlowRuntimeJsonObject {
  return {
    ui_kind: 'consent',
    statements: statements.map((entry) => ({
      statement_id: entry.statement_id,
      required: entry.required,
    })),
  };
}

/** The statements a consent node asks, or null when it lists none it can read. */
export function readConsentStepStatements(node: unknown): FlowConsentStatement[] | null {
  if (!isRecord(node) || node.type !== 'consent') return null;
  const statements = readFlowConsentStatements(node.config);
  return statements && statements.length > 0 ? statements : null;
}

/** A consent step as the spec holds it (`when` only when it is shown to some people). */
export function consentStep(
  statements: FlowConsentStatement[],
  when: FlowStepWhen | null
): FlowConsentStep {
  return hasWhen(when ?? undefined) ? { statements, when: when as FlowStepWhen } : { statements };
}
