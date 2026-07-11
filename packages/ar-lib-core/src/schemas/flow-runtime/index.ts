/**
 * LoginUI Flow runtime contract schema and helpers.
 *
 * This module is the shared boundary between AdminUI Flow editing, Management API
 * publish validation, and LoginUI runtime execution. It intentionally avoids a
 * third-party validator dependency so ar-lib-core can stay lightweight.
 */

export const FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION = 'authrim.login_ui.contract.v1' as const;
export const FLOW_RUNTIME_INTERACTION_TTL_SECONDS = 600 as const;

export type FlowRuntimeMode = 'draft' | 'preview' | 'runtime' | 'export';

export type FlowKind = 'login' | 'registration' | 'approve' | 'account' | `custom:${string}`;

export type FlowAssignmentTargetType = 'tenant' | 'oidc_client' | 'saml_sp';

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
  | 'condition';

export type FlowNodeType = FlowStandardNodeType | `custom:${string}`;

export type FlowNodeCategory = 'control' | 'decision' | 'input' | 'authentication' | 'consent';

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
    required_config_keys: ['consent_policy_ref'],
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
    issues.push(
      ...validateFlowEditorState(input.editor).map((issue) => ({
        ...issue,
        path: issue.path?.replace('$.editor', '$.editor') ?? '$.editor',
      }))
    );
  }

  return issues;
}

export type FlowConditionType =
  | 'always'
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
  | 'organization_membership';

export interface FlowConditionExpression {
  type: FlowConditionType;
  value?: string | boolean | number;
  values?: Array<string | boolean | number>;
  attribute?: string;
  policy_ref?: FlowReference;
  org_ref?: FlowReference;
  match?: 'allow' | 'deny' | 'any';
  membership?: string[];
}

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
  authenticated?: boolean;
  first_login?: boolean;
  client_id?: string;
  saml_sp_id?: string;
  flow_kind?: FlowKind;
  requested_scope?: string[];
  user?: FlowConditionEvaluationUser;
  authentication_method?: string;
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
        !definition.output_handles.includes(sourceHandle)
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

  return issues;
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
    }
  });

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

function matchScalar(value: string | undefined, condition: FlowConditionExpression): boolean {
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
  if (condition.values) {
    return condition.values.map(String).some((candidate) => values.includes(candidate));
  }
  if (condition.value !== undefined) {
    return values.includes(String(condition.value));
  }
  return false;
}

function matchUserAttribute(
  user: FlowConditionEvaluationUser | undefined,
  condition: FlowConditionExpression
): boolean {
  if (!user || !condition.attribute) {
    return false;
  }
  const value = user.attributes?.[condition.attribute];
  if (Array.isArray(value)) {
    return matchArray(value.map(String), condition);
  }
  if (value === undefined || value === null) {
    return false;
  }
  return matchScalar(String(value), condition);
}
