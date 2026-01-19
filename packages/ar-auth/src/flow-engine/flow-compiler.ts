/**
 * FlowCompiler - GraphDefinitionをCompiledPlanに変換
 *
 * 責務:
 * - GraphDefinition（編集用）→ CompiledPlan（実行用）変換
 * - ノードのMap化
 * - 遷移マップの構築
 * - CapabilityTemplateの解決
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

/** CompiledPlanのバージョン */
const COMPILED_PLAN_VERSION = '1.0.0';

// =============================================================================
// FlowCompilerService
// =============================================================================

/**
 * FlowCompilerService - GraphDefinitionをCompiledPlanにコンパイル
 */
export class FlowCompilerService implements FlowCompiler {
  /**
   * GraphDefinitionをCompiledPlanにコンパイル
   *
   * @param graph - GraphDefinition
   * @returns CompiledPlan
   */
  compile(graph: GraphDefinition): CompiledPlan {
    // 1. ノードマップを構築
    const nodes = this.buildNodeMap(graph);

    // 2. 遷移マップを構築
    const transitions = this.buildTransitionMap(graph.edges);

    // 3. Decision/Switchノードの遷移にpriorityを設定してソート
    this.enrichTransitionsWithPriority(nodes, transitions);

    // 4. 各ノードのnextOnSuccess/nextOnErrorを設定
    this.resolveNodeTransitions(nodes, transitions);

    // 5. エントリーポイントを特定
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
   * ノードマップを構築
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
   * GraphNodeをCompiledNodeにコンパイル
   */
  private compileNode(node: GraphNode): CompiledNode {
    // Derive intent from node type if not specified
    const intent = node.data.intent ?? this.deriveIntentFromType(node.type);

    const compiledNode: CompiledNode = {
      id: node.id,
      type: node.type,
      intent,
      capabilities: this.resolveCapabilities(node.data.capabilities, node.id),
      nextOnSuccess: null, // 後で遷移マップから設定
      nextOnError: null, // 後で遷移マップから設定
    };

    // Decision/Switchノードの場合は設定を保持
    if (node.type === 'decision' || node.type === 'switch') {
      compiledNode.decisionConfig = this.compileDecisionConfig(node);
    }

    return compiledNode;
  }

  /**
   * Decision/Switchノードの設定をコンパイル
   *
   * セキュリティ対策:
   * - DoS攻撃防止のため、分岐数に制限を設ける
   * - Decision: 最大50分岐
   * - Switch: 最大100ケース
   */
  private compileDecisionConfig(
    node: GraphNode
  ): DecisionNodeConfig | SwitchNodeConfig | undefined {
    const config = node.data.config;

    // セキュリティ制限定数
    const MAX_DECISION_BRANCHES = 50;
    const MAX_SWITCH_CASES = 100;

    if (node.type === 'decision') {
      // DecisionNodeConfig として解釈
      const decisionConfig = config as unknown as DecisionNodeConfig | undefined;

      // DoS攻撃対策: 分岐数制限
      if (decisionConfig && decisionConfig.branches.length > MAX_DECISION_BRANCHES) {
        throw new Error(
          `[Security] Decision node "${node.id}" has too many branches: ${decisionConfig.branches.length} (max: ${MAX_DECISION_BRANCHES})`
        );
      }

      return decisionConfig;
    }

    if (node.type === 'switch') {
      // SwitchNodeConfig として解釈
      const switchConfig = config as unknown as SwitchNodeConfig | undefined;

      // DoS攻撃対策: ケース数制限
      if (switchConfig && switchConfig.cases.length > MAX_SWITCH_CASES) {
        throw new Error(
          `[Security] Switch node "${node.id}" has too many cases: ${switchConfig.cases.length} (max: ${MAX_SWITCH_CASES})`
        );
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
   * CapabilityTemplateをResolvedCapabilityに解決
   */
  private resolveCapabilities(
    templates: CapabilityTemplate[] | undefined,
    nodeId: string
  ): ResolvedCapability[] {
    if (!templates || templates.length === 0) {
      return [];
    }
    return templates.map((template) => this.resolveCapability(template, nodeId));
  }

  /**
   * 単一のCapabilityTemplateをResolvedCapabilityに解決
   */
  private resolveCapability(template: CapabilityTemplate, nodeId: string): ResolvedCapability {
    // ID生成: ${nodeId}_${idSuffix}
    const id = `${nodeId}_${template.idSuffix}`;

    // ヒントをデフォルト値で補完
    const hints: CapabilityHints = {
      ...this.getDefaultHints(template.type),
      ...template.hintsTemplate,
    };

    // バリデーションルールをコピー
    const validationRules: ValidationRule[] = template.validationRules || [];

    // 安定性レベルを決定
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
   * CapabilityTypeに応じたデフォルトヒントを取得
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
   * CapabilityTypeに応じた安定性レベルを取得
   */
  private getStabilityLevel(type: string): StabilityLevel {
    // コアCapabilityはcore、それ以外はstable
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
   * 遷移マップを構築
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
   * GraphEdgeをCompiledTransitionにコンパイル
   */
  private compileTransition(edge: GraphEdge): CompiledTransition {
    const transition: CompiledTransition = {
      targetNodeId: edge.target,
      type: edge.type,
    };

    // sourceHandleを保持（Decision/Switchノード用）
    if (edge.sourceHandle) {
      transition.sourceHandle = edge.sourceHandle;
    }

    // 条件付き遷移の場合、条件をコンパイル
    if (edge.type === 'conditional' && edge.data?.condition) {
      transition.condition = this.compileCondition(edge.data.condition);
    }

    return transition;
  }

  /**
   * EdgeConditionをCompiledConditionにコンパイル
   */
  private compileCondition(condition: { type: string; expression: string }): CompiledCondition {
    return {
      type: condition.type as CompiledCondition['type'],
      expression: condition.expression,
      evaluate: this.createEvaluator(condition.type, condition.expression),
    };
  }

  /**
   * 条件評価関数を作成
   */
  private createEvaluator(
    type: string,
    expression: string
  ): (context: EvaluationContext) => boolean {
    switch (type) {
      case 'capability_result':
        // capability応答に基づく評価
        return (context) => {
          // 簡易実装: capabilityIdが完了済みかチェック
          const capabilityId = expression.replace('completed:', '');
          return context.completedCapabilities.includes(capabilityId);
        };

      case 'feature_flag':
        // 機能フラグに基づく評価
        return (context) => {
          const flagName = expression;
          return context.featureFlags?.[flagName] ?? false;
        };

      case 'policy_check':
        // ポリシーチェック（将来実装）
        return () => true;

      case 'custom':
        // カスタム式（簡易評価）
        return (context) => {
          // allowRetry === true のような簡単な式を評価
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
   * Decision/Switchノードの遷移にpriorityを設定してソート
   */
  private enrichTransitionsWithPriority(
    nodes: Map<string, CompiledNode>,
    transitions: Map<string, CompiledTransition[]>
  ): void {
    for (const [nodeId, node] of nodes) {
      // Decision/Switchノード以外はスキップ
      if (node.type !== 'decision' && node.type !== 'switch') {
        continue;
      }

      const nodeTransitions = transitions.get(nodeId);
      if (!nodeTransitions || !node.decisionConfig) {
        continue;
      }

      if (node.type === 'decision') {
        // DecisionNodeConfig の branches から priority を設定
        const config = node.decisionConfig as DecisionNodeConfig;

        for (const transition of nodeTransitions) {
          if (!transition.sourceHandle) continue;

          // sourceHandle に対応する branch を検索
          const branch = config.branches.find((b) => b.id === transition.sourceHandle);
          if (branch) {
            transition.priority = branch.priority;
          }
        }

        // priority順にソート（小さい方が先）
        nodeTransitions.sort((a, b) => {
          const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
          const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
          return priorityA - priorityB;
        });
      }

      if (node.type === 'switch') {
        // Switchノードは priority を設定しない（定義順を維持）
        // 必要に応じて将来的に priority を追加可能
      }
    }
  }

  /**
   * 各ノードのnextOnSuccess/nextOnErrorを設定
   */
  private resolveNodeTransitions(
    nodes: Map<string, CompiledNode>,
    transitions: Map<string, CompiledTransition[]>
  ): void {
    for (const [nodeId, node] of nodes) {
      const nodeTransitions = transitions.get(nodeId) || [];

      // success遷移を検索
      const successTransition = nodeTransitions.find((t) => t.type === 'success');
      if (successTransition) {
        node.nextOnSuccess = successTransition.targetNodeId;
      }

      // error遷移を検索
      const errorTransition = nodeTransitions.find((t) => t.type === 'error');
      if (errorTransition) {
        node.nextOnError = errorTransition.targetNodeId;
      }
    }
  }

  /**
   * エントリーポイントノードを特定
   */
  private findEntryNode(nodes: GraphNode[]): string {
    // startタイプのノードを検索
    const startNode = nodes.find((n) => n.type === 'start');

    if (startNode) {
      return startNode.id;
    }

    // startノードがない場合は最初のノード
    if (nodes.length > 0) {
      return nodes[0].id;
    }

    throw new Error('No nodes found in GraphDefinition');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * FlowCompilerを作成
 *
 * @returns FlowCompiler インスタンス
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
