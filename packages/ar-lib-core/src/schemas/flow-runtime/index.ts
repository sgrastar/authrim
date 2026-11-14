/**
 * LoginUI Flow runtime contract schema and helpers.
 *
 * This module is the shared boundary between AdminUI Flow editing, Management API
 * publish validation, and LoginUI runtime execution. It intentionally avoids a
 * third-party validator dependency so ar-lib-core can stay lightweight.
 */

import { SCREEN_LINK_EXIT_PATTERN, SCREEN_RESERVED_EXITS } from '../../types/screens';
import {
  ageOn,
  FLOW_CONDITION_OPERATORS,
  FLOW_CONDITION_ORDERING_OPERATORS,
  isOrderableConditionValue,
  matchOperator,
  type FlowConditionOperand,
  type FlowConditionOperator,
} from './condition-operators';

export {
  ageOn,
  FLOW_CONDITION_OPERATORS,
  matchOperator,
  type FlowConditionOperator,
} from './condition-operators';

export const FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION = 'authrim.login_ui.contract.v1' as const;
export const FLOW_RUNTIME_INTERACTION_TTL_SECONDS = 600 as const;

export type FlowRuntimeMode = 'draft' | 'preview' | 'runtime' | 'export';

export type FlowKind =
  | 'login'
  | 'registration'
  | 'approve'
  | 'account'
  | 'credential_issuance'
  | 'attribute_elevation'
  | `custom:${string}`;

export type FlowAssignmentTargetType = 'tenant' | 'oidc_client' | 'saml_sp' | 'credential_profile';

export type FlowRuntimeJsonPrimitive = string | number | boolean | null;
export type FlowRuntimeJsonValue =
  | FlowRuntimeJsonPrimitive
  | FlowRuntimeJsonObject
  | FlowRuntimeJsonValue[];
export interface FlowRuntimeJsonObject {
  [key: string]: FlowRuntimeJsonValue;
}

export interface FlowReference {
  id: string;
  slug?: string;
  display_name?: string;
}

export type FlowRuntimeComponent =
  | 'interaction_context'
  | 'session_check'
  | 'registration_method_selector'
  | 'authentication_method_selector'
  | 'email_verification'
  | 'screen'
  | 'consent_policy'
  | 'account_action'
  | 'completion'
  | 'condition'
  | 'credential_claims'
  | 'credential_offer'
  | 'credential_presentation'
  | 'verified_attribute'
  | `custom:${string}`;

export type FlowStandardNodeType =
  | 'entry'
  | 'session_check'
  | 'registration'
  | 'authentication'
  | 'email_verification'
  | 'screen'
  | 'consent'
  | 'account_action'
  | 'complete'
  | 'condition'
  | 'credential_claims'
  | 'credential_offer'
  | 'credential_presentation'
  | 'verified_attribute';

export type FlowNodeType = FlowStandardNodeType | `custom:${string}`;

export type FlowNodeCategory =
  | 'control'
  | 'decision'
  | 'input'
  | 'authentication'
  | 'consent'
  | 'system';

export interface FlowNodeDefinition {
  type: FlowStandardNodeType;
  label: string;
  runtime_component: FlowRuntimeComponent;
  category: FlowNodeCategory;
  accepts_input: boolean;
  emits_output: boolean;
  default_render: boolean;
  output_handles: readonly string[] | 'dynamic';
  required_config_keys?: readonly string[];
}

/** An exit a screen's link part may name (see `SCREEN_LINK_EXIT_PATTERN`). */
function isScreenExitName(handle: string): boolean {
  return SCREEN_LINK_EXIT_PATTERN.test(handle) && !SCREEN_RESERVED_EXITS.includes(handle);
}

export const FLOW_NODE_DEFINITIONS: readonly FlowNodeDefinition[] = [
  {
    type: 'entry',
    label: 'Entry',
    runtime_component: 'interaction_context',
    category: 'control',
    accepts_input: false,
    emits_output: true,
    default_render: false,
    output_handles: ['next'],
  },
  {
    type: 'session_check',
    label: 'Session Check',
    runtime_component: 'session_check',
    category: 'decision',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['continue', 'authenticate'],
  },
  {
    type: 'registration',
    label: 'Registration',
    runtime_component: 'registration_method_selector',
    category: 'authentication',
    accepts_input: true,
    emits_output: true,
    default_render: true,
    output_handles: 'dynamic',
    required_config_keys: ['authentication_profile_ref'],
  },
  {
    type: 'authentication',
    label: 'Authentication',
    runtime_component: 'authentication_method_selector',
    category: 'authentication',
    accepts_input: true,
    emits_output: true,
    default_render: true,
    output_handles: 'dynamic',
    required_config_keys: ['authentication_profile_ref'],
  },
  {
    type: 'email_verification',
    label: 'Email Verification',
    runtime_component: 'email_verification',
    category: 'authentication',
    accepts_input: true,
    emits_output: true,
    default_render: true,
    output_handles: ['verified', 'failed'],
  },
  {
    type: 'screen',
    label: 'Profile Screen',
    runtime_component: 'screen',
    category: 'input',
    accepts_input: true,
    emits_output: true,
    default_render: true,
    output_handles: ['submitted', 'skipped'],
  },
  {
    type: 'consent',
    label: 'Consent',
    runtime_component: 'consent_policy',
    category: 'consent',
    accepts_input: true,
    emits_output: true,
    default_render: true,
    output_handles: ['accepted', 'declined'],
    required_config_keys: ['statements'],
  },
  {
    type: 'account_action',
    label: 'Account Action',
    runtime_component: 'account_action',
    category: 'input',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['completed', 'cancelled'],
  },
  {
    type: 'complete',
    label: 'Complete',
    runtime_component: 'completion',
    category: 'control',
    accepts_input: true,
    emits_output: false,
    default_render: true,
    output_handles: [],
  },
  {
    type: 'condition',
    label: 'Condition',
    runtime_component: 'condition',
    category: 'decision',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: 'dynamic',
    required_config_keys: ['conditions'],
  },
  {
    type: 'credential_claims',
    label: 'Resolve Credential Claims',
    runtime_component: 'credential_claims',
    category: 'system',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['resolved', 'rejected'],
    required_config_keys: ['credential_profile_ref'],
  },
  {
    type: 'credential_offer',
    label: 'Create Credential Offer',
    runtime_component: 'credential_offer',
    category: 'system',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['created', 'failed'],
    required_config_keys: ['credential_profile_ref'],
  },
  {
    type: 'credential_presentation',
    label: 'Verify Credential Presentation',
    runtime_component: 'credential_presentation',
    category: 'system',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['verified', 'rejected'],
    required_config_keys: ['credential_profile_ref'],
  },
  {
    type: 'verified_attribute',
    label: 'Commit Verified Attributes',
    runtime_component: 'verified_attribute',
    category: 'system',
    accepts_input: true,
    emits_output: true,
    default_render: false,
    output_handles: ['committed', 'rejected'],
    required_config_keys: ['credential_profile_ref'],
  },
];

export const FLOW_NODE_DEFINITION_BY_TYPE = Object.fromEntries(
  FLOW_NODE_DEFINITIONS.map((definition) => [definition.type, definition])
) as Record<FlowStandardNodeType, FlowNodeDefinition>;

export function isStandardFlowNodeType(value: string): value is FlowStandardNodeType {
  return Object.prototype.hasOwnProperty.call(FLOW_NODE_DEFINITION_BY_TYPE, value);
}

export function isCustomFlowNodeType(value: string): value is `custom:${string}` {
  return value.startsWith('custom:') && value.length > 'custom:'.length;
}

export function isFlowNodeType(value: string): value is FlowNodeType {
  return isStandardFlowNodeType(value) || isCustomFlowNodeType(value);
}

export function getFlowNodeDefinition(type: FlowNodeType): FlowNodeDefinition | undefined {
  if (!isStandardFlowNodeType(type)) {
    return undefined;
  }
  return FLOW_NODE_DEFINITION_BY_TYPE[type];
}

export interface FlowEditorPosition {
  x: number;
  y: number;
}

export interface FlowEditorNode {
  id: string;
  type: FlowNodeType;
  title?: string;
  position?: FlowEditorPosition;
  config?: FlowRuntimeJsonObject;
  data?: FlowRuntimeJsonObject;
}

export interface FlowEditorEdge {
  id: string;
  source: string;
  target: string;
  source_handle?: string;
  target_handle?: string;
  label?: string;
  data?: FlowRuntimeJsonObject;
}

export interface FlowEditorViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface FlowEditorState {
  nodes: FlowEditorNode[];
  edges: FlowEditorEdge[];
  viewport?: FlowEditorViewport;
}

export interface FlowRuntimeStep {
  id: string;
  source_node_id: string;
  component: FlowRuntimeComponent;
  render: boolean;
  capability_ids?: string[];
  bindings?: Record<string, FlowReference | FlowReference[]>;
  content?: FlowRuntimeJsonObject;
  config?: FlowRuntimeJsonObject;
}

export interface FlowRuntimeContract {
  flow_kind: FlowKind;
  flow_id?: string;
  flow_version_id?: string;
  ui: {
    steps: FlowRuntimeStep[];
  };
  capabilities?: FlowRuntimeJsonObject[];
  runtime_bindings?: Record<string, FlowReference | FlowReference[]>;
  protocol_context?: FlowProtocolContext;
}

export interface FlowRuntimeContractPackage {
  schema_version: typeof FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION;
  mode: FlowRuntimeMode;
  runtime: FlowRuntimeContract;
  preview?: FlowRuntimeJsonObject;
  editor?: FlowEditorState;
}

export interface FlowRuntimeStartResponse {
  interaction_id: string;
  flow_id: string;
  flow_version_id: string;
  expires_at: string;
  contract_hash: string;
  signature: string;
  runtime: FlowRuntimeContract;
}

export type FlowRuntimeErrorCategory =
  | 'recoverable'
  | 'restart_required'
  | 'reauthentication_required'
  | 'configuration_error'
  | 'security_error'
  | 'terminal_error';

export type FlowRuntimeErrorAction =
  | 'retry_step'
  | 'restart_interaction'
  | 'reauthenticate'
  | 'show_terminal_error'
  | 'contact_administrator';

export interface FlowRuntimeErrorResponse {
  error: string;
  error_description: string;
  error_code: string;
  category: FlowRuntimeErrorCategory;
  action: FlowRuntimeErrorAction;
  interaction_id?: string;
}

export interface FlowProtocolContext {
  protocol: 'oidc' | 'saml' | 'direct' | `custom:${string}`;
  request: FlowRuntimeJsonObject;
  oidc?: FlowRuntimeJsonObject | null;
  saml?: FlowRuntimeJsonObject | null;
}

export type FlowValidationLevel = 'error' | 'warning';

export interface FlowValidationIssue {
  level: FlowValidationLevel;
  code: string;
  message: string;
  path?: string;
  node_id?: string | null;
  edge_id?: string | null;
  ref?: {
    type: 'node' | 'edge' | 'reference' | 'handle' | 'config';
    id?: string;
    key?: string;
  };
}

export interface FlowValidationOptions {
  for_publish?: boolean;
}

export function validateFlowRuntimeContractPackage(input: unknown): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];

  if (!isRecord(input)) {
    return [
      {
        level: 'error',
        code: 'invalid_contract_package',
        message: 'Flow runtime contract package must be an object.',
        path: '$',
      },
    ];
  }

  if (input.schema_version !== FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION) {
    issues.push({
      level: 'error',
      code: 'invalid_schema_version',
      message: 'Flow runtime contract package has an unsupported schema version.',
      path: '$.schema_version',
    });
  }

  if (
    input.mode !== 'draft' &&
    input.mode !== 'preview' &&
    input.mode !== 'runtime' &&
    input.mode !== 'export'
  ) {
    issues.push({
      level: 'error',
      code: 'invalid_mode',
      message: 'Flow runtime contract package mode is invalid.',
      path: '$.mode',
    });
  }

  if (!isRecord(input.runtime)) {
    issues.push({
      level: 'error',
      code: 'missing_runtime',
      message: 'Flow runtime contract package is missing runtime data.',
      path: '$.runtime',
    });
  } else {
    issues.push(...validateRuntimeContract(input.runtime));
  }

  if (input.editor !== undefined) {
    issues.push(...validateFlowEditorState(input.editor));
  }

  return issues;
}

export type FlowConditionType =
  | 'always'
  | 'protocol'
  | 'authenticated'
  | 'first_login'
  | 'client_id'
  | 'saml_sp_id'
  | 'flow_kind'
  | 'requested_scope'
  | 'user.attribute'
  | 'user.group'
  | 'user.role'
  | 'authentication_method'
  | 'policy_rule'
  | 'policy_evaluation'
  | 'organization_membership'
  /** A choice a screen step sent to the Flow (`attribute` is its answer key). */
  | 'screen.answer'
  /** The user's age in whole years, from their `birthdate` attribute. */
  | 'user.age'
  /** The language the run is shown in. */
  | 'locale'
  /** Every condition of `all` holds (one level: no `all` inside). */
  | 'all';

export interface FlowConditionExpression {
  type: FlowConditionType;
  value?: string | boolean | number;
  values?: Array<string | boolean | number>;
  attribute?: string;
  policy_ref?: FlowReference;
  org_ref?: FlowReference;
  match?: 'allow' | 'deny' | 'any';
  membership?: string[];
  /** How the value is compared (see `condition-operators.ts`). None: equal to one of the values. */
  operator?: FlowConditionOperator;
  /** For `all`: the conditions that must all hold. */
  all?: FlowConditionExpression[];
}

/** The most conditions an `all` condition combines. */
export const MAX_FLOW_CONDITION_ALL = 10;
/** The longest user attribute key a condition names. */
export const MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH = 100;
/** The oldest age a `user.age` condition compares with. */
export const MAX_FLOW_CONDITION_AGE = 150;

export interface FlowConditionRow {
  id: string;
  label?: string;
  condition: FlowConditionExpression;
  output_handle: string;
}

export interface FlowConditionTerminalError {
  error: string;
  message?: string;
}

export interface FlowConditionOtherwise {
  output_handle?: string;
  terminal_error?: FlowConditionTerminalError;
}

export interface FlowConditionConfig {
  rows: FlowConditionRow[];
  otherwise: FlowConditionOtherwise;
}

export interface FlowConditionEvaluationUser {
  attributes?: Record<string, string | number | boolean | string[] | null | undefined>;
  groups?: string[];
  roles?: string[];
  org_ids?: string[];
}

export interface FlowConditionEvaluationContext {
  protocol?: 'direct' | 'oidc' | 'saml' | `custom:${string}`;
  authenticated?: boolean;
  first_login?: boolean;
  client_id?: string;
  saml_sp_id?: string;
  flow_kind?: FlowKind;
  requested_scope?: string[];
  user?: FlowConditionEvaluationUser;
  authentication_method?: string;
  /** The choices screen steps sent to the Flow, by answer key (see `screenAnswersOf`). */
  screen_answers?: Record<string, string | boolean>;
  /** The language the run is shown in. */
  locale?: string;
  /** When the conditions are judged (an age is the age on this day); now when absent. */
  now_ms?: number;
}

/** The longest answer key a screen answer condition names. */
export const MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH = 100;

/** One screen step's choices kept with an interaction, by answer key. */
export interface ScreenAnswerEntry {
  step_id: string;
  answers: Record<string, unknown>;
}

/**
 * The choices kept with an interaction (`context_json.screen_answers`), one entry per step, the
 * step answered last at the end. Kept as a list: an object's own keys do not keep the order they
 * were set in when they look like integers (a step id may), so a step answered again could not
 * be told to be the latest. The object by step id an earlier runtime wrote is read too.
 */
export function screenAnswerEntriesOf(raw: unknown): ScreenAnswerEntry[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) =>
      isRecord(entry) && typeof entry.step_id === 'string' && isRecord(entry.answers)
        ? [{ step_id: entry.step_id, answers: entry.answers }]
        : []
    );
  }
  if (!isRecord(raw)) return [];
  return Object.entries(raw).flatMap(([stepId, answers]) =>
    isRecord(answers) ? [{ step_id: stepId, answers }] : []
  );
}

/**
 * The kept choices by answer key (see screenAnswerEntriesOf). A key answered on more than one
 * step takes the step answered last.
 */
export function screenAnswersOf(raw: unknown): Record<string, string | boolean> {
  const answers: Record<string, string | boolean> = {};
  for (const entry of screenAnswerEntriesOf(raw)) {
    for (const [key, value] of Object.entries(entry.answers)) {
      if (typeof value === 'string' || typeof value === 'boolean') answers[key] = value;
    }
  }
  return answers;
}

export interface FlowConditionResolvers {
  evaluate_policy?: (
    condition: FlowConditionExpression,
    context: FlowConditionEvaluationContext
  ) => Promise<boolean> | boolean;
  is_organization_member?: (
    condition: FlowConditionExpression,
    context: FlowConditionEvaluationContext
  ) => Promise<boolean> | boolean;
}

export type FlowConditionEvaluationResult =
  | {
      matched: true;
      row: FlowConditionRow;
      output_handle: string;
    }
  | {
      matched: false;
      output_handle?: string;
      terminal_error?: FlowConditionTerminalError;
    };

export async function evaluateFlowConditionRows(
  config: FlowConditionConfig,
  context: FlowConditionEvaluationContext,
  resolvers: FlowConditionResolvers = {}
): Promise<FlowConditionEvaluationResult> {
  for (const row of config.rows) {
    if (await evaluateFlowCondition(row.condition, context, resolvers)) {
      return {
        matched: true,
        row,
        output_handle: row.output_handle,
      };
    }
  }

  return {
    matched: false,
    output_handle: config.otherwise.output_handle,
    terminal_error: config.otherwise.terminal_error,
  };
}

export async function evaluateFlowCondition(
  condition: FlowConditionExpression,
  context: FlowConditionEvaluationContext,
  resolvers: FlowConditionResolvers = {}
): Promise<boolean> {
  switch (condition.type) {
    case 'always':
      return true;
    case 'protocol':
      return matchScalar(context.protocol, condition);
    case 'authenticated':
      return context.authenticated === conditionBooleanValue(condition, true);
    case 'first_login':
      return context.first_login === conditionBooleanValue(condition, true);
    case 'client_id':
      return matchScalar(context.client_id, condition);
    case 'saml_sp_id':
      return matchScalar(context.saml_sp_id, condition);
    case 'flow_kind':
      return matchScalar(context.flow_kind, condition);
    case 'requested_scope':
      return matchArray(context.requested_scope ?? [], condition);
    case 'user.attribute':
      return matchUserAttribute(context.user, condition);
    case 'user.group':
      return matchArray(context.user?.groups ?? [], condition);
    case 'user.role':
      return matchArray(context.user?.roles ?? [], condition);
    case 'authentication_method':
      return matchScalar(context.authentication_method, condition);
    case 'screen.answer':
      return matchScreenAnswer(context.screen_answers, condition);
    case 'user.age':
      return matchCompared(
        ageOn(ownValue(context.user?.attributes, 'birthdate'), context.now_ms ?? Date.now()),
        condition
      );
    case 'locale':
      return matchCompared(context.locale, condition);
    case 'all': {
      const members = condition.all ?? [];
      if (members.length === 0) return false;
      for (const member of members) {
        // One level only: an `all` inside never holds.
        if (member.type === 'all' || !(await evaluateFlowCondition(member, context, resolvers))) {
          return false;
        }
      }
      return true;
    }
    case 'policy_rule':
    case 'policy_evaluation':
      if (!resolvers.evaluate_policy) {
        return false;
      }
      try {
        return await resolvers.evaluate_policy(condition, context);
      } catch {
        return false;
      }
    case 'organization_membership':
      if (resolvers.is_organization_member) {
        try {
          return await resolvers.is_organization_member(condition, context);
        } catch {
          return false;
        }
      }
      return condition.org_ref?.id
        ? (context.user?.org_ids ?? []).includes(condition.org_ref.id)
        : false;
  }
}

export function validateFlowEditorState(
  editor: unknown,
  options: FlowValidationOptions = {}
): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];

  if (!isRecord(editor)) {
    return [
      {
        level: 'error',
        code: 'invalid_editor_state',
        message: 'Flow editor state must be an object.',
        path: '$.editor',
      },
    ];
  }

  const nodesValue = editor.nodes;
  const edgesValue = editor.edges;

  if (!Array.isArray(nodesValue)) {
    issues.push({
      level: 'error',
      code: 'invalid_nodes',
      message: 'Flow editor state must contain a nodes array.',
      path: '$.editor.nodes',
    });
  }
  if (!Array.isArray(edgesValue)) {
    issues.push({
      level: 'error',
      code: 'invalid_edges',
      message: 'Flow editor state must contain an edges array.',
      path: '$.editor.edges',
    });
  }
  if (!Array.isArray(nodesValue) || !Array.isArray(edgesValue)) {
    return issues;
  }

  const nodeIds = new Set<string>();
  const nodeTypes = new Map<string, FlowNodeType>();
  const nodeConfigs = new Map<string, Record<string, unknown>>();
  const completionBlocks = new Map<
    string,
    { id: string; protocol?: string; purpose?: string; role?: string }
  >();
  let entryCount = 0;
  let completeCount = 0;

  nodesValue.forEach((nodeValue, index) => {
    const path = `$.editor.nodes[${index}]`;
    if (!isRecord(nodeValue)) {
      issues.push({
        level: 'error',
        code: 'invalid_node',
        message: 'Flow node must be an object.',
        path,
      });
      return;
    }

    const id = typeof nodeValue.id === 'string' ? nodeValue.id : '';
    const type = typeof nodeValue.type === 'string' ? nodeValue.type : '';

    if (!id) {
      issues.push({
        level: 'error',
        code: 'missing_node_id',
        message: 'Flow node is missing an id.',
        path: `${path}.id`,
        node_id: null,
      });
    } else if (nodeIds.has(id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_node_id',
        message: `Duplicate Flow node id: ${id}.`,
        path: `${path}.id`,
        node_id: id,
      });
    } else {
      nodeIds.add(id);
    }

    if (!type || !isFlowNodeType(type)) {
      issues.push({
        level: 'error',
        code: 'invalid_node_type',
        message: `Invalid Flow node type: ${type || '(missing)'}.`,
        path: `${path}.type`,
        node_id: id || null,
      });
      return;
    }

    if (isCustomFlowNodeType(type) && options.for_publish) {
      issues.push({
        level: 'error',
        code: 'unsupported_custom_node',
        message: `Custom Flow node type is not supported by the initial runtime: ${type}.`,
        path: `${path}.type`,
        node_id: id || null,
      });
      return;
    }

    if (type === 'entry') {
      entryCount += 1;
    }
    if (type === 'complete') {
      completeCount += 1;
    }
    if (id && isFlowNodeType(type)) {
      nodeTypes.set(id, type);
      const config = isRecord(nodeValue.config) ? nodeValue.config : {};
      nodeConfigs.set(id, config);
      const completionBlock = readCompletionBlock(config.completion_block);
      if (completionBlock) {
        completionBlocks.set(id, completionBlock);
      }
    }

    const definition = isStandardFlowNodeType(type) ? getFlowNodeDefinition(type) : undefined;
    const config = isRecord(nodeValue.config) ? nodeValue.config : undefined;
    for (const key of definition?.required_config_keys ?? []) {
      if (!config || config[key] === undefined || config[key] === null || config[key] === '') {
        issues.push({
          level: options.for_publish ? 'error' : 'warning',
          code: 'missing_required_node_config',
          message: `Flow node is missing required config: ${key}.`,
          path: `${path}.config.${key}`,
          node_id: id || null,
          ref: {
            type: 'config',
            key,
          },
        });
      }
    }
    if (id && type === 'condition') {
      issues.push(...validateConditionNodeConfig(config, path, id, options));
    }
  });

  if (entryCount === 0) {
    issues.push({
      level: 'error',
      code: 'missing_entry_node',
      message: 'Flow must contain an Entry node.',
      path: '$.editor.nodes',
    });
  }
  if (entryCount > 1) {
    issues.push({
      level: 'error',
      code: 'multiple_entry_nodes',
      message: 'Flow must contain only one Entry node.',
      path: '$.editor.nodes',
    });
  }
  if (completeCount === 0) {
    issues.push({
      level: 'error',
      code: 'missing_complete_node',
      message: 'Flow must contain a Complete node.',
      path: '$.editor.nodes',
    });
  }

  edgesValue.forEach((edgeValue, index) => {
    const path = `$.editor.edges[${index}]`;
    if (!isRecord(edgeValue)) {
      issues.push({
        level: 'error',
        code: 'invalid_edge',
        message: 'Flow edge must be an object.',
        path,
      });
      return;
    }

    const edgeId = typeof edgeValue.id === 'string' ? edgeValue.id : '';
    const source = typeof edgeValue.source === 'string' ? edgeValue.source : '';
    const target = typeof edgeValue.target === 'string' ? edgeValue.target : '';

    if (!edgeId) {
      issues.push({
        level: 'error',
        code: 'missing_edge_id',
        message: 'Flow edge is missing an id.',
        path: `${path}.id`,
      });
    }
    if (!source || !nodeIds.has(source)) {
      issues.push({
        level: 'error',
        code: 'missing_node_reference',
        message: 'Edge references a source node that does not exist.',
        path: `${path}.source`,
        edge_id: edgeId || null,
        ref: {
          type: 'node',
          id: source,
        },
      });
    }
    if (!target || !nodeIds.has(target)) {
      issues.push({
        level: 'error',
        code: 'missing_node_reference',
        message: 'Edge references a target node that does not exist.',
        path: `${path}.target`,
        edge_id: edgeId || null,
        ref: {
          type: 'node',
          id: target,
        },
      });
    }

    const sourceType = source ? nodeTypes.get(source) : undefined;
    if (source && sourceType) {
      const definition = getFlowNodeDefinition(sourceType);
      const sourceHandle =
        typeof edgeValue.source_handle === 'string' ? edgeValue.source_handle : undefined;

      if (definition && !definition.emits_output) {
        issues.push({
          level: 'error',
          code: 'invalid_edge_source',
          message: 'Edge source node does not emit output.',
          path: `${path}.source`,
          node_id: source,
          edge_id: edgeId || null,
        });
      }

      if (
        definition &&
        sourceHandle &&
        definition.output_handles !== 'dynamic' &&
        !definition.output_handles.includes(sourceHandle) &&
        // A screen also leaves by the exits its link parts name (checked at runtime).
        !(sourceType === 'screen' && isScreenExitName(sourceHandle))
      ) {
        issues.push({
          level: 'error',
          code: 'invalid_output_handle',
          message: `Source handle is not supported by node type ${sourceType}: ${sourceHandle}.`,
          path: `${path}.source_handle`,
          node_id: source,
          edge_id: edgeId || null,
          ref: {
            type: 'handle',
            id: sourceHandle,
          },
        });
      }
      if (
        definition &&
        sourceHandle &&
        definition.output_handles === 'dynamic' &&
        !dynamicSourceHandleAllowed(nodeConfigs.get(source) ?? {}, sourceHandle)
      ) {
        issues.push({
          level: 'error',
          code: 'invalid_output_handle',
          message: `Source handle is not configured by node ${source}: ${sourceHandle}.`,
          path: `${path}.source_handle`,
          node_id: source,
          edge_id: edgeId || null,
          ref: {
            type: 'handle',
            id: sourceHandle,
          },
        });
      }
    }

    const targetType = target ? nodeTypes.get(target) : undefined;
    if (target && targetType) {
      const definition = getFlowNodeDefinition(targetType);
      if (definition && !definition.accepts_input) {
        issues.push({
          level: 'error',
          code: 'invalid_edge_target',
          message: 'Edge target node does not accept input.',
          path: `${path}.target`,
          node_id: target,
          edge_id: edgeId || null,
        });
      }
    }

    if (source && target && nodeIds.has(source) && nodeIds.has(target)) {
      const sourceBlock = completionBlocks.get(source);
      const targetBlock = completionBlocks.get(target);
      if (
        sourceBlock &&
        targetBlock &&
        sourceBlock.id !== targetBlock.id &&
        sourceBlock.protocol &&
        targetBlock.protocol &&
        sourceBlock.protocol !== targetBlock.protocol
      ) {
        issues.push({
          level: 'error',
          code: 'completion_block_protocol_mismatch',
          message: 'Edge connects nodes that belong to different protocol completion blocks.',
          path,
          edge_id: edgeId || null,
          ref: {
            type: 'edge',
            id: edgeId || undefined,
            key: 'completion_block',
          },
        });
      }
      if (
        sourceBlock &&
        targetBlock &&
        sourceBlock.id !== targetBlock.id &&
        sourceBlock.purpose &&
        targetBlock.purpose &&
        sourceBlock.purpose !== targetBlock.purpose
      ) {
        issues.push({
          level: 'error',
          code: 'completion_block_purpose_mismatch',
          message: 'Edge connects nodes that belong to different completion block purposes.',
          path,
          edge_id: edgeId || null,
          ref: {
            type: 'edge',
            id: edgeId || undefined,
            key: 'completion_block',
          },
        });
      }
    }
  });

  for (const [conditionNodeId, config] of nodeConfigs.entries()) {
    if (nodeTypes.get(conditionNodeId) !== 'condition') continue;
    const conditions = isRecord(config.conditions) ? config.conditions : null;
    const rows = Array.isArray(conditions?.rows) ? conditions.rows : [];
    const protocolRows = rows.flatMap((row) => {
      if (!isRecord(row) || !isRecord(row.condition) || row.condition.type !== 'protocol') {
        return [];
      }
      const protocol = row.condition.value;
      const outputHandle = row.output_handle;
      return typeof protocol === 'string' && typeof outputHandle === 'string'
        ? [{ protocol, outputHandle }]
        : [];
    });
    for (const row of protocolRows) {
      const branchTargets = edgesValue.flatMap((edge) =>
        isRecord(edge) &&
        edge.source === conditionNodeId &&
        edge.source_handle === row.outputHandle &&
        typeof edge.target === 'string'
          ? [edge.target]
          : []
      );
      if (branchTargets.length === 0) {
        issues.push({
          level: options.for_publish ? 'error' : 'warning',
          code: 'missing_protocol_condition_edge',
          message: `Protocol condition branch ${row.protocol} has no outgoing edge.`,
          path: '$.editor.edges',
          node_id: conditionNodeId,
          ref: { type: 'handle', id: row.outputHandle },
        });
        continue;
      }

      const reachableCompletionIds = collectReachableCompletionNodeIds(
        branchTargets,
        edgesValue,
        nodeTypes
      );
      if (reachableCompletionIds.length === 0) {
        issues.push({
          level: options.for_publish ? 'error' : 'warning',
          code: 'missing_protocol_condition_completion',
          message: `Protocol condition branch ${row.protocol} does not reach a Complete node.`,
          path: '$.editor.edges',
          node_id: conditionNodeId,
          ref: { type: 'handle', id: row.outputHandle },
        });
        continue;
      }

      for (const completionNodeId of reachableCompletionIds) {
        const completionProtocol = completionBlocks.get(completionNodeId)?.protocol;
        if (completionProtocol !== row.protocol) {
          issues.push({
            level: 'error',
            code: 'protocol_condition_completion_mismatch',
            message: `Protocol condition branch ${row.protocol} reaches a completion for ${completionProtocol ?? 'an unspecified protocol'}.`,
            path: '$.editor.edges',
            node_id: completionNodeId,
            ref: { type: 'config', key: 'completion_block.protocol' },
          });
        }
      }
    }
  }

  return issues;
}

function collectReachableCompletionNodeIds(
  initialNodeIds: string[],
  edges: unknown[],
  nodeTypes: Map<string, FlowNodeType>
): string[] {
  const reachableCompletions = new Set<string>();
  const visited = new Set<string>();
  const pending = [...initialNodeIds];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    if (nodeTypes.get(nodeId) === 'complete') {
      reachableCompletions.add(nodeId);
      continue;
    }
    for (const edge of edges) {
      if (isRecord(edge) && edge.source === nodeId && typeof edge.target === 'string') {
        pending.push(edge.target);
      }
    }
  }
  return [...reachableCompletions];
}

function readCompletionBlock(
  value: unknown
): { id: string; protocol?: string; purpose?: string; role?: string } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
    return null;
  }
  return {
    id: value.id,
    ...(typeof value.protocol === 'string' ? { protocol: value.protocol } : {}),
    ...(typeof value.purpose === 'string' ? { purpose: value.purpose } : {}),
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
  };
}

function dynamicSourceHandleAllowed(
  config: Record<string, unknown>,
  sourceHandle: string
): boolean {
  const handles = new Set<string>();
  const outputs = Array.isArray(config.outputs) ? config.outputs : [];
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    if (typeof output.id === 'string' && output.id.length > 0) {
      handles.add(output.id);
    }
  }

  const conditionHandles = conditionOutputHandles(config.conditions);
  for (const handle of conditionHandles) {
    handles.add(handle);
  }

  return handles.size === 0 || handles.has(sourceHandle);
}

function conditionOutputHandles(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const handles: string[] = [];
  const rows = Array.isArray(value.rows) ? value.rows : [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (typeof row.output_handle === 'string' && row.output_handle.length > 0) {
      handles.push(row.output_handle);
    }
  }
  if (isRecord(value.otherwise) && typeof value.otherwise.output_handle === 'string') {
    handles.push(value.otherwise.output_handle);
  }
  return handles;
}

function validateConditionNodeConfig(
  config: Record<string, unknown> | undefined,
  nodePath: string,
  nodeId: string,
  options: FlowValidationOptions
): FlowValidationIssue[] {
  const level: FlowValidationLevel = options.for_publish ? 'error' : 'warning';
  const issues: FlowValidationIssue[] = [];
  const conditions = config?.conditions;
  if (!isRecord(conditions)) {
    return issues;
  }

  const rows = Array.isArray(conditions.rows) ? conditions.rows : [];
  if (rows.length === 0) {
    issues.push({
      level,
      code: 'missing_condition_rows',
      message: 'Condition node must contain at least one condition row.',
      path: `${nodePath}.config.conditions.rows`,
      node_id: nodeId,
      ref: { type: 'config', key: 'conditions.rows' },
    });
  }

  rows.forEach((row, index) => {
    const rowPath = `${nodePath}.config.conditions.rows[${index}]`;
    if (!isRecord(row)) {
      issues.push({
        level,
        code: 'invalid_condition_row',
        message: 'Condition row must be an object.',
        path: rowPath,
        node_id: nodeId,
      });
      return;
    }
    if (typeof row.output_handle !== 'string' || row.output_handle.length === 0) {
      issues.push({
        level,
        code: 'missing_condition_output_handle',
        message: 'Condition row is missing output_handle.',
        path: `${rowPath}.output_handle`,
        node_id: nodeId,
        ref: { type: 'config', key: 'output_handle' },
      });
    }
    const condition = row.condition;
    if (!isRecord(condition) || typeof condition.type !== 'string' || condition.type.length === 0) {
      issues.push({
        level,
        code: 'missing_condition_type',
        message: 'Condition row is missing condition.type.',
        path: `${rowPath}.condition.type`,
        node_id: nodeId,
        ref: { type: 'config', key: 'condition.type' },
      });
    } else if (!FLOW_CONDITION_TYPES.has(condition.type as FlowConditionType)) {
      issues.push({
        level,
        code: 'invalid_condition_type',
        message: `Condition type is not supported: ${condition.type}.`,
        path: `${rowPath}.condition.type`,
        node_id: nodeId,
        ref: { type: 'config', key: 'condition.type' },
      });
    } else if (
      condition.type === 'screen.answer' &&
      (typeof condition.attribute !== 'string' ||
        condition.attribute.trim() === '' ||
        condition.attribute.length > MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH)
    ) {
      issues.push({
        level,
        code: 'invalid_screen_answer_condition',
        message: 'A screen answer condition names the answer key it compares.',
        path: `${rowPath}.condition.attribute`,
        node_id: nodeId,
        ref: { type: 'config', key: 'condition.attribute' },
      });
    } else if (
      condition.type === 'protocol' &&
      condition.value !== 'oidc' &&
      condition.value !== 'saml'
    ) {
      issues.push({
        level,
        code: 'invalid_protocol_condition_value',
        message: 'Protocol condition value must be oidc or saml.',
        path: `${rowPath}.condition.value`,
        node_id: nodeId,
        ref: { type: 'config', key: 'condition.value' },
      });
    } else {
      const problem = conditionExpressionIssue(condition, false);
      if (problem) {
        issues.push({
          level,
          code: problem.code,
          message: problem.message,
          path: `${rowPath}.condition.${problem.key}`,
          node_id: nodeId,
          ref: { type: 'config', key: `condition.${problem.key}` },
        });
      }
    }
  });

  const protocolRows = rows.filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) && isRecord(row.condition) && row.condition.type === 'protocol'
  );
  if (protocolRows.length > 0) {
    const configuredProtocols = new Set(
      protocolRows.flatMap((row) => {
        const condition = row.condition as Record<string, unknown>;
        return typeof condition.value === 'string' ? [condition.value] : [];
      })
    );
    if (configuredProtocols.size !== protocolRows.length) {
      issues.push({
        level,
        code: 'duplicate_protocol_condition_branch',
        message: 'Protocol condition must define each protocol branch exactly once.',
        path: `${nodePath}.config.conditions.rows`,
        node_id: nodeId,
        ref: { type: 'config', key: 'conditions.rows' },
      });
    }
  }

  if (!isRecord(conditions.otherwise)) {
    issues.push({
      level,
      code: 'missing_condition_otherwise',
      message: 'Condition node must define otherwise behavior.',
      path: `${nodePath}.config.conditions.otherwise`,
      node_id: nodeId,
      ref: { type: 'config', key: 'conditions.otherwise' },
    });
  } else {
    const otherwise = conditions.otherwise;
    const hasOutput =
      typeof otherwise.output_handle === 'string' && otherwise.output_handle.length > 0;
    const terminal = otherwise.terminal_error;
    const hasTerminal =
      isRecord(terminal) && typeof terminal.error === 'string' && terminal.error.length > 0;
    if (!hasOutput && !hasTerminal) {
      issues.push({
        level,
        code: 'missing_condition_otherwise_action',
        message: 'Condition otherwise must select an output handle or terminal error.',
        path: `${nodePath}.config.conditions.otherwise`,
        node_id: nodeId,
        ref: { type: 'config', key: 'conditions.otherwise' },
      });
    }
  }

  return issues;
}

const FLOW_CONDITION_TYPES = new Set<FlowConditionType>([
  'always',
  'protocol',
  'authenticated',
  'first_login',
  'client_id',
  'saml_sp_id',
  'flow_kind',
  'requested_scope',
  'user.attribute',
  'user.group',
  'user.role',
  'authentication_method',
  'policy_rule',
  'policy_evaluation',
  'organization_membership',
  'screen.answer',
  'user.age',
  'locale',
  'all',
]);

/** The condition kinds that may name an operator (`condition-operators.ts`). */
const OPERATOR_CONDITION_TYPES = new Set<FlowConditionType>([
  'protocol',
  'client_id',
  'saml_sp_id',
  'flow_kind',
  'requested_scope',
  'user.attribute',
  'user.group',
  'user.role',
  'authentication_method',
  'screen.answer',
  'user.age',
  'locale',
]);
/** The condition kinds whose values can be ordered (numbers or dates). */
const ORDERED_CONDITION_TYPES = new Set<FlowConditionType>(['user.attribute', 'user.age']);
/** A user attribute key: a standard profile claim (`birthdate`, `address.country`) or a custom one. */
const USER_ATTRIBUTE_KEY = /^[a-z][a-z0-9_.:-]*$/u;

interface ConditionIssue {
  code: string;
  message: string;
  /** Where in the condition (after `condition.`). */
  key: string;
}

function conditionScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isAge(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FLOW_CONDITION_AGE
  );
}

/**
 * What is wrong with a condition's own fields beyond its kind (its operator, values, attribute
 * key, the conditions an `all` combines), or null. `nested`: inside an `all`.
 */
function conditionExpressionIssue(
  condition: Record<string, unknown>,
  nested: boolean
): ConditionIssue | null {
  const type = condition.type as FlowConditionType;
  if (type === 'all') {
    if (nested) {
      return {
        code: 'nested_all_condition',
        message: 'An all condition cannot hold another.',
        key: 'type',
      };
    }
    const members = condition.all;
    if (
      !Array.isArray(members) ||
      members.length === 0 ||
      members.length > MAX_FLOW_CONDITION_ALL
    ) {
      return {
        code: 'invalid_all_condition',
        message: `An all condition combines 1 to ${MAX_FLOW_CONDITION_ALL} conditions.`,
        key: 'all',
      };
    }
    for (const [index, member] of members.entries()) {
      if (
        !isRecord(member) ||
        typeof member.type !== 'string' ||
        !FLOW_CONDITION_TYPES.has(member.type as FlowConditionType)
      ) {
        return {
          code: 'invalid_condition_type',
          message: 'Each condition of an all condition needs a supported type.',
          key: `all[${index}].type`,
        };
      }
      const problem = conditionExpressionIssue(member, true);
      if (problem) return { ...problem, key: `all[${index}].${problem.key}` };
    }
    return null;
  }
  if (nested && type === 'screen.answer') {
    const key = condition.attribute;
    if (
      typeof key !== 'string' ||
      key.trim() === '' ||
      key.length > MAX_SCREEN_ANSWER_CONDITION_KEY_LENGTH
    ) {
      return {
        code: 'invalid_screen_answer_condition',
        message: 'A screen answer condition names the answer key it compares.',
        key: 'attribute',
      };
    }
  }
  if (nested && type === 'protocol' && condition.value !== 'oidc' && condition.value !== 'saml') {
    return {
      code: 'invalid_protocol_condition_value',
      message: 'Protocol condition value must be oidc or saml.',
      key: 'value',
    };
  }
  if (type === 'user.attribute') {
    const key = condition.attribute;
    if (
      typeof key !== 'string' ||
      key.length > MAX_USER_ATTRIBUTE_CONDITION_KEY_LENGTH ||
      !USER_ATTRIBUTE_KEY.test(key)
    ) {
      return {
        code: 'invalid_user_attribute_condition',
        message: 'A user attribute condition names the attribute it compares.',
        key: 'attribute',
      };
    }
  }
  // Values are a list (the runtime maps over them).
  if (condition.values !== undefined && !Array.isArray(condition.values)) {
    return {
      code: 'invalid_condition_value',
      message: 'The values a condition compares with are a list.',
      key: 'values',
    };
  }
  const operator = condition.operator;
  if (operator === undefined) {
    // As before: equal to its value or one of its values. An age is a whole number of years.
    if (type === 'user.age') {
      const values = Array.isArray(condition.values) ? condition.values : [condition.value];
      if (values.length === 0 || !values.every(isAge)) {
        return {
          code: 'invalid_age_condition_value',
          message: `An age is a whole number from 0 to ${MAX_FLOW_CONDITION_AGE}.`,
          key: 'value',
        };
      }
    }
    return null;
  }
  if (
    typeof operator !== 'string' ||
    !FLOW_CONDITION_OPERATORS.has(operator as FlowConditionOperator) ||
    !OPERATOR_CONDITION_TYPES.has(type) ||
    // A protocol branch is checked against the completion it leads to as one protocol: only
    // `eq` (what the condition means without an operator) is taken.
    (type === 'protocol' && operator !== 'eq')
  ) {
    return {
      code: 'invalid_condition_operator',
      message: `The operator is not supported for a ${type} condition.`,
      key: 'operator',
    };
  }
  const op = operator as FlowConditionOperator;
  if (op === 'exists' || op === 'not_exists') return null;
  if (FLOW_CONDITION_ORDERING_OPERATORS.has(op)) {
    const value = condition.value;
    const comparable =
      condition.values === undefined &&
      ORDERED_CONDITION_TYPES.has(type) &&
      (type === 'user.age' ? isAge(value) : isOrderableConditionValue(value));
    return comparable
      ? null
      : {
          code: 'invalid_condition_value',
          message:
            type === 'user.age'
              ? `An age is a whole number from 0 to ${MAX_FLOW_CONDITION_AGE}.`
              : 'An ordering condition compares with one number or date.',
          key: 'value',
        };
  }
  const values = Array.isArray(condition.values)
    ? condition.values
    : condition.value === undefined
      ? []
      : [condition.value];
  const usable =
    values.length > 0 &&
    values.every((value) => (type === 'user.age' ? isAge(value) : conditionScalar(value)));
  return usable
    ? null
    : {
        code: 'invalid_condition_value',
        message: 'The condition names the values it compares with.',
        key: 'value',
      };
}

/**
 * The user attributes the conditions of a run read (a `user.age` reads `birthdate`), so only
 * those are loaded: none when no condition reads one.
 */
export function conditionUserAttributeKeys(conditions: readonly unknown[]): string[] {
  const keys = new Set<string>();
  const visit = (condition: unknown) => {
    if (!isRecord(condition)) return;
    if (condition.type === 'user.attribute' && typeof condition.attribute === 'string') {
      keys.add(condition.attribute);
    } else if (condition.type === 'user.age') {
      keys.add('birthdate');
    } else if (condition.type === 'all' && Array.isArray(condition.all)) {
      condition.all.forEach(visit);
    }
  };
  conditions.forEach(visit);
  return [...keys];
}

/** Condition types that read the person signed in (their account, roles, groups, organisations). */
const SIGNED_IN_USER_CONDITION_TYPES: ReadonlySet<string> = new Set([
  'user.attribute',
  'user.group',
  'user.role',
  'user.age',
  'organization_membership',
  'policy_rule',
  'policy_evaluation',
]);

/**
 * Whether any of these conditions reads the person signed in: judged before anyone is, it would
 * be judged for nobody. A run that is waiting for the sign-in (the method chosen, the proof still
 * to come) holds such a condition until then.
 */
export function conditionsReadSignedInUser(conditions: readonly unknown[]): boolean {
  const reads = (condition: unknown): boolean => {
    if (!isRecord(condition)) return false;
    if (typeof condition.type === 'string' && SIGNED_IN_USER_CONDITION_TYPES.has(condition.type)) {
      return true;
    }
    return condition.type === 'all' && Array.isArray(condition.all) && condition.all.some(reads);
  };
  return conditions.some(reads);
}

/** The conditions of one condition step (its rows'). */
export function stepConditionExpressions(
  step: Pick<FlowRuntimeStep, 'component' | 'config'>
): unknown[] {
  if (step.component !== 'condition' || !isRecord(step.config)) return [];
  const conditions = step.config.conditions;
  if (!isRecord(conditions) || !Array.isArray(conditions.rows)) return [];
  return conditions.rows.flatMap((row) => (isRecord(row) ? [row.condition] : []));
}

/** The conditions of every condition step of a contract (to know what a run will read). */
export function runtimeConditionExpressions(runtime: Pick<FlowRuntimeContract, 'ui'>): unknown[] {
  return runtime.ui.steps.flatMap(stepConditionExpressions);
}

function validateRuntimeContract(runtime: Record<string, unknown>): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];

  if (typeof runtime.flow_kind !== 'string') {
    issues.push({
      level: 'error',
      code: 'missing_flow_kind',
      message: 'Runtime contract is missing flow_kind.',
      path: '$.runtime.flow_kind',
    });
  }

  if (!isRecord(runtime.ui)) {
    issues.push({
      level: 'error',
      code: 'missing_runtime_ui',
      message: 'Runtime contract is missing ui data.',
      path: '$.runtime.ui',
    });
    return issues;
  }

  if (!Array.isArray(runtime.ui.steps)) {
    issues.push({
      level: 'error',
      code: 'missing_runtime_steps',
      message: 'Runtime contract ui must contain a steps array.',
      path: '$.runtime.ui.steps',
    });
    return issues;
  }

  runtime.ui.steps.forEach((stepValue, index) => {
    const path = `$.runtime.ui.steps[${index}]`;
    if (!isRecord(stepValue)) {
      issues.push({
        level: 'error',
        code: 'invalid_runtime_step',
        message: 'Runtime step must be an object.',
        path,
      });
      return;
    }

    if (typeof stepValue.id !== 'string' || stepValue.id.length === 0) {
      issues.push({
        level: 'error',
        code: 'missing_runtime_step_id',
        message: 'Runtime step is missing an id.',
        path: `${path}.id`,
      });
    }
    if (typeof stepValue.source_node_id !== 'string' || stepValue.source_node_id.length === 0) {
      issues.push({
        level: 'error',
        code: 'missing_runtime_source_node',
        message: 'Runtime step is missing source_node_id.',
        path: `${path}.source_node_id`,
      });
    }
    if (typeof stepValue.component !== 'string' || stepValue.component.length === 0) {
      issues.push({
        level: 'error',
        code: 'missing_runtime_component',
        message: 'Runtime step is missing component.',
        path: `${path}.component`,
      });
    }
    if (typeof stepValue.render !== 'boolean') {
      issues.push({
        level: 'error',
        code: 'missing_runtime_render_flag',
        message: 'Runtime step is missing render flag.',
        path: `${path}.render`,
      });
    }
  });

  return issues;
}

export function sanitizeImportedFlowContract(input: unknown): unknown {
  return sanitizeValue(input);
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && isVolatileRuntimeKey(key)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const sanitizedItems: unknown[] = [];
    for (const item of value) {
      const sanitized = sanitizeValue(item);
      if (sanitized !== undefined) {
        sanitizedItems.push(sanitized);
      }
    }
    return sanitizedItems;
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitizedValue = sanitizeValue(entryValue, entryKey);
      if (sanitizedValue !== undefined) {
        sanitized[entryKey] = sanitizedValue;
      }
    }
    return sanitized;
  }

  return value;
}

function isVolatileRuntimeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const compact = normalized.replace(/[-_]/g, '');
  return (
    normalized === 'submit' ||
    normalized === 'security' ||
    normalized === 'interaction_id' ||
    normalized === 'nonce' ||
    normalized === 'expires_at' ||
    normalized === 'csrf_token' ||
    normalized === 'contract_hash' ||
    normalized === 'signature' ||
    normalized === 'one_time_url' ||
    normalized === 'one_time_token' ||
    normalized === 'access_token' ||
    normalized === 'refresh_token' ||
    normalized === 'id_token' ||
    normalized === 'token' ||
    compact === 'interactionid' ||
    compact === 'csrftoken' ||
    compact === 'contracthash' ||
    compact === 'onetimeurl' ||
    compact === 'onetimetoken' ||
    compact === 'accesstoken' ||
    compact === 'refreshtoken' ||
    compact === 'idtoken' ||
    compact.endsWith('token')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function conditionBooleanValue(condition: FlowConditionExpression, fallback: boolean): boolean {
  return typeof condition.value === 'boolean' ? condition.value : fallback;
}

/** A value against a condition: by its operator when it names one, else as `matchScalar` does. */
function matchCompared(value: FlowConditionOperand, condition: FlowConditionExpression): boolean {
  if (condition.operator)
    return matchOperator(value, { ...condition, operator: condition.operator });
  if (value === undefined || value === null) return false;
  return Array.isArray(value)
    ? matchArray(value.map(String), condition)
    : matchScalar(String(value), condition);
}

function matchScalar(value: string | undefined, condition: FlowConditionExpression): boolean {
  if (condition.operator)
    return matchOperator(value, { ...condition, operator: condition.operator });
  if (value === undefined) {
    return false;
  }
  if (condition.values) {
    return condition.values.map(String).includes(value);
  }
  if (condition.value !== undefined) {
    return String(condition.value) === value;
  }
  return false;
}

function matchArray(values: string[], condition: FlowConditionExpression): boolean {
  if (condition.operator)
    return matchOperator(values, { ...condition, operator: condition.operator });
  if (condition.values) {
    return condition.values.map(String).some((candidate) => values.includes(candidate));
  }
  if (condition.value !== undefined) {
    return values.includes(String(condition.value));
  }
  return false;
}

/** A screen answer, as its text (a checkbox's `true` or `false`), against the condition's values. */
function matchScreenAnswer(
  answers: Record<string, string | boolean> | undefined,
  condition: FlowConditionExpression
): boolean {
  if (!answers || !condition.attribute) return false;
  const value = Object.prototype.hasOwnProperty.call(answers, condition.attribute)
    ? answers[condition.attribute]
    : undefined;
  return matchCompared(value === undefined ? undefined : String(value), condition);
}

/** An attribute the user has (own key only: never one inherited, such as `constructor`). */
function ownValue<T>(attributes: Record<string, T> | undefined, key: string): T | undefined {
  return attributes && Object.prototype.hasOwnProperty.call(attributes, key)
    ? attributes[key]
    : undefined;
}

function matchUserAttribute(
  user: FlowConditionEvaluationUser | undefined,
  condition: FlowConditionExpression
): boolean {
  if (!condition.attribute) {
    return false;
  }
  if (!user) {
    // Nothing is known of someone not signed in: only a condition that matches nothing known can.
    return condition.operator
      ? matchOperator(undefined, { ...condition, operator: condition.operator })
      : false;
  }
  const value = ownValue(user.attributes, condition.attribute);
  return matchCompared(Array.isArray(value) ? value.map(String) : value, condition);
}
