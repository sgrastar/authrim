/**
 * FlowCompiler - Convert GraphDefinition to CompiledPlan
 *
 * Responsibilities:
 * - GraphDefinition (for editing)→ CompiledPlan (for execution)convert
 * - Map nodes by ID
 * - Build the transition map
 * - Resolve CapabilityTemplate
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type {
  GraphDefinition,
  GraphNode,
  GraphEdge,
  CapabilityTemplate,
  CompiledPlan,
  CompiledNode,
  CompiledTransition,
  CompiledCondition,
  ResolvedCapability,
  FlowCompiler,
  EvaluationContext,
  DecisionNodeConfig,
  SwitchNodeConfig,
} from './types';
import type { CapabilityHints, ValidationRule, StabilityLevel } from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

/** CompiledPlan version */
const COMPILED_PLAN_VERSION = '1.0.0';

/** DoS mitigation: maximum capabilities per node */
const MAX_CAPABILITIES_PER_NODE = 20;

// =============================================================================
// FlowCompilerService
// =============================================================================

/**
 * FlowCompilerService - Compile GraphDefinition into CompiledPlan
 */
export class FlowCompilerService implements FlowCompiler {
  /**
   * Compile GraphDefinition into CompiledPlan
   *
   * @param graph - GraphDefinition
   * @returns CompiledPlan
   */
  compile(graph: GraphDefinition): CompiledPlan {
    // 1. Build the node map
    const nodes = this.buildNodeMap(graph);

    // 2. Build the transition map
    const transitions = this.buildTransitionMap(graph.edges);

    // 3. Set priorities on Decision/Switch transitions and sort them
    this.enrichTransitionsWithPriority(nodes, transitions);

    // 4. Set nextOnSuccess/nextOnError for each node
    this.resolveNodeTransitions(nodes, transitions);

    // 5. Identify the entry point
    const entryNodeId = this.findEntryNode(graph.nodes);

    return {
      id: `compiled-${graph.id}`,
      version: COMPILED_PLAN_VERSION,
      sourceVersion: graph.flowVersion,
      profileId: graph.profileId,
      entryNodeId,
      nodes,
      transitions,
      compiledAt: new Date().toISOString(),
    };
  }

  /**
   * Build the node map
   */
  private buildNodeMap(graph: GraphDefinition): Map<string, CompiledNode> {
    const nodes = new Map<string, CompiledNode>();

    for (const node of graph.nodes) {
      const compiledNode = this.compileNode(node);
      nodes.set(node.id, compiledNode);
    }

    return nodes;
  }

  /**
   * Compile GraphNode to CompiledNode
   */
  private compileNode(node: GraphNode): CompiledNode {
    // Derive intent from node type if not specified
    const intent = node.data.intent ?? this.deriveIntentFromType(node.type);

    const compiledNode: CompiledNode = {
      id: node.id,
      type: node.type,
      intent,
      capabilities: this.resolveCapabilities(node.data.capabilities, node.id),
      nextOnSuccess: null, // Set later from the transition map
      nextOnError: null, // Set later from the transition map
    };

    // Keep the configuration for Decision/Switch nodes
    if (node.type === 'decision' || node.type === 'switch') {
      compiledNode.decisionConfig = this.compileDecisionConfig(node);
    }

    return compiledNode;
  }

  /**
   * Compile Decision/Switch node configuration
   *
   * Security mitigation:
   * - to prevent DoS attacks, limit the number of branches
   * - Decision: maximum 50 branches
   * - Switch: maximum 100 cases
   */
  private compileDecisionConfig(
    node: GraphNode
  ): DecisionNodeConfig | SwitchNodeConfig | undefined {
    const config = node.data.config;

    // Security limit constants
    const MAX_DECISION_BRANCHES = 50;
    const MAX_SWITCH_CASES = 100;
    const MAX_VALUES_PER_CASE = 100; // Maximum values per Switch case

    if (node.type === 'decision') {
      // Interpret as DecisionNodeConfig
      const decisionConfig = config as unknown as DecisionNodeConfig | undefined;

      // DoS mitigation: branch count limit
      if (decisionConfig && decisionConfig.branches.length > MAX_DECISION_BRANCHES) {
        // Security mitigation (High 6): details only in logs; keep error messages generic
        console.error(
          `[Security] Decision node "${node.id}" has too many branches: ${decisionConfig.branches.length} (max: ${MAX_DECISION_BRANCHES})`
        );
        throw new Error('Invalid flow configuration');
      }

      return decisionConfig;
    }

    if (node.type === 'switch') {
      // Interpret as SwitchNodeConfig
      const switchConfig = config as unknown as SwitchNodeConfig | undefined;

      if (switchConfig) {
        // DoS mitigation: case count limit
        if (switchConfig.cases.length > MAX_SWITCH_CASES) {
          // Security mitigation (High 6): details only in logs; keep error messages generic
          console.error(
            `[Security] Switch node "${node.id}" has too many cases: ${switchConfig.cases.length} (max: ${MAX_SWITCH_CASES})`
          );
          throw new Error('Invalid flow configuration');
        }

        // DoS mitigation: limit the number of values per case
        for (const caseItem of switchConfig.cases) {
          if (caseItem.values.length > MAX_VALUES_PER_CASE) {
            // Security mitigation (High 6): details only in logs; keep error messages generic
            console.error(
              `[Security] Switch case "${caseItem.id}" in node "${node.id}" has too many values: ${caseItem.values.length} (max: ${MAX_VALUES_PER_CASE})`
            );
            throw new Error('Invalid flow configuration');
          }
        }
      }

      return switchConfig;
    }

    return undefined;
  }

  /**
   * Derive intent from node type for nodes without explicit intent
   */
  private deriveIntentFromType(type: string): string {
    const intentMap: Record<string, string> = {
      start: 'flow_start',
      end: 'flow_end',
      login: 'authenticate',
      register: 'register',
      mfa: 'mfa_verify',
      consent: 'consent',
      identifier: 'identifier_input',
      auth_method_select: 'auth_method_select',
      check_session: 'check_session',
      redirect: 'redirect',
      error: 'error',
      decision: 'decision',
      condition: 'condition',
    };
    return intentMap[type] ?? type;
  }

  /**
   * Resolve CapabilityTemplate to ResolvedCapability
   */
  private resolveCapabilities(
    templates: CapabilityTemplate[] | undefined,
    nodeId: string
  ): ResolvedCapability[] {
    if (!templates || templates.length === 0) {
      return [];
    }

    // DoS mitigation: limit Capability array size
    if (templates.length > MAX_CAPABILITIES_PER_NODE) {
      // Security mitigation (High 6): details only in logs; keep error messages generic
      console.error(
        `[Security] Node "${nodeId}" has too many capabilities: ${templates.length} (max: ${MAX_CAPABILITIES_PER_NODE})`
      );
      throw new Error('Invalid flow configuration');
    }

    return templates.map((template) => this.resolveCapability(template, nodeId));
  }

  /**
   * Resolve a single CapabilityTemplate to ResolvedCapability
   */
  private resolveCapability(template: CapabilityTemplate, nodeId: string): ResolvedCapability {
    // Generate ID: ${nodeId}_${idSuffix}
    const id = `${nodeId}_${template.idSuffix}`;

    // Fill hints with default values
    const hints: CapabilityHints = {
      ...this.getDefaultHints(template.type),
      ...template.hintsTemplate,
    };

    // Copy validation rules
    const validationRules: ValidationRule[] = template.validationRules || [];

    // Determine stability level
    const stability = this.getStabilityLevel(template.type);

    return {
      type: template.type,
      id,
      required: template.required,
      hints,
      validationRules,
      stability,
    };
  }

  /**
   * Get default hints for the CapabilityType
   */
  private getDefaultHints(type: string): Partial<CapabilityHints> {
    const defaults: Record<string, Partial<CapabilityHints>> = {
      collect_identifier: {
        inputType: 'email',
        autoFocus: true,
      },
      collect_secret: {
        inputType: 'password',
      },
      verify_possession: {
        webauthn: {
          mode: 'authenticate',
          discoverable: true,
          userVerification: 'preferred',
        },
      },
      display_info: {
        variant: 'info',
      },
      confirm_consent: {},
      redirect: {},
    };

    return defaults[type] || {};
  }

  /**
   * Get stability level for the CapabilityType
   */
  private getStabilityLevel(type: string): StabilityLevel {
    // Core capabilities are core; all others are stable
    const coreCapabilities = [
      'collect_identifier',
      'collect_secret',
      'verify_possession',
      'display_info',
      'redirect',
      'confirm_consent',
    ];

    return coreCapabilities.includes(type) ? 'core' : 'stable';
  }

  /**
   * Build the transition map
   */
  private buildTransitionMap(edges: GraphEdge[]): Map<string, CompiledTransition[]> {
    const transitions = new Map<string, CompiledTransition[]>();

    for (const edge of edges) {
      const transition = this.compileTransition(edge);

      if (!transitions.has(edge.source)) {
        transitions.set(edge.source, []);
      }

      transitions.get(edge.source)!.push(transition);
    }

    return transitions;
  }

  /**
   * Compile GraphEdge to CompiledTransition
   */
  private compileTransition(edge: GraphEdge): CompiledTransition {
    const transition: CompiledTransition = {
      targetNodeId: edge.target,
      type: edge.type,
    };

    // Preserve sourceHandle (Decision/Switch nodefor)
    if (edge.sourceHandle) {
      transition.sourceHandle = edge.sourceHandle;
    }

    // For conditional transitions, compile the condition
    if (edge.type === 'conditional' && edge.data?.condition) {
      transition.condition = this.compileCondition(edge.data.condition);
    }

    return transition;
  }

  /**
   * Compile EdgeCondition to CompiledCondition
   */
  private compileCondition(condition: { type: string; expression: string }): CompiledCondition {
    return {
      type: condition.type as CompiledCondition['type'],
      expression: condition.expression,
      evaluate: this.createEvaluator(condition.type, condition.expression),
    };
  }

  /**
   * Create the condition evaluation function
   */
  private createEvaluator(
    type: string,
    expression: string
  ): (context: EvaluationContext) => boolean {
    switch (type) {
      case 'capability_result':
        // Evaluation based on capability response
        return (context) => {
          // simple implementation: check whether capabilityId is complete
          const capabilityId = expression.replace('completed:', '');
          return context.completedCapabilities.includes(capabilityId);
        };

      case 'feature_flag':
        // Evaluation based on feature flags
        return (context) => {
          const flagName = expression;
          return context.featureFlags?.[flagName] ?? false;
        };

      case 'policy_check':
        // policy check (future implementation)
        return () => true;

      case 'custom':
        // Custom expression (simple evaluation)
        return (context) => {
          // Evaluate a simple expression such as allowRetry === true
          if (expression === 'allowRetry === true') {
            return (context.collectedData as { allowRetry?: boolean }).allowRetry === true;
          }
          return true;
        };

      default:
        return () => true;
    }
  }

  /**
   * Set priorities on Decision/Switch transitions and sort them
   */
  private enrichTransitionsWithPriority(
    nodes: Map<string, CompiledNode>,
    transitions: Map<string, CompiledTransition[]>
  ): void {
    for (const [nodeId, node] of nodes) {
      // Skip non-Decision/Switch nodes
      if (node.type !== 'decision' && node.type !== 'switch') {
        continue;
      }

      const nodeTransitions = transitions.get(nodeId);
      if (!nodeTransitions || !node.decisionConfig) {
        continue;
      }

      if (node.type === 'decision') {
        // Set priority from DecisionNodeConfig branches
        const config = node.decisionConfig as DecisionNodeConfig;

        for (const transition of nodeTransitions) {
          if (!transition.sourceHandle) continue;

          // find the branch matching sourceHandle
          const branch = config.branches.find((b) => b.id === transition.sourceHandle);
          if (branch) {
            transition.priority = branch.priority;
          }
        }

        // Sort by priority order (lower values first)
        nodeTransitions.sort((a, b) => {
          const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
          const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
          return priorityA - priorityB;
        });
      }

      if (node.type === 'switch') {
        // Switch nodes do not set priority (preserve definition order)
        // priority can be added in the future if needed
      }
    }
  }

  /**
   * Set nextOnSuccess/nextOnError for each node
   */
  private resolveNodeTransitions(
    nodes: Map<string, CompiledNode>,
    transitions: Map<string, CompiledTransition[]>
  ): void {
    for (const [nodeId, node] of nodes) {
      const nodeTransitions = transitions.get(nodeId) || [];

      // Find success transition
      const successTransition = nodeTransitions.find((t) => t.type === 'success');
      if (successTransition) {
        node.nextOnSuccess = successTransition.targetNodeId;
      }

      // Find error transition
      const errorTransition = nodeTransitions.find((t) => t.type === 'error');
      if (errorTransition) {
        node.nextOnError = errorTransition.targetNodeId;
      }
    }
  }

  /**
   * Identify the entry point node
   */
  private findEntryNode(nodes: GraphNode[]): string {
    // Find a start-type node
    const startNode = nodes.find((n) => n.type === 'start');

    if (startNode) {
      return startNode.id;
    }

    // Use the first node when there is no start node
    if (nodes.length > 0) {
      return nodes[0].id;
    }

    // Security mitigation (High 6): details only in logs; keep error messages generic
    console.error('[Security] No nodes found in GraphDefinition');
    throw new Error('Invalid flow configuration');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create FlowCompiler
 *
 * @returns FlowCompiler instance
 *
 * @example
 * const compiler = createFlowCompiler();
 * const plan = compiler.compile(graphDefinition);
 */
export function createFlowCompiler(): FlowCompiler {
  return new FlowCompilerService();
}

// =============================================================================
// Export
// =============================================================================

export default FlowCompilerService;
