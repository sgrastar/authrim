/**
 * UIContractGenerator - Generate UIContract from CompiledNode
 *
 * Responsibilities:
 * - Generate UIContract from CompiledNode + context
 * - ResolvedCapability → Capability conversion
 * - FeatureFlags generation
 * - ActionSet generation
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { CompiledNode, RuntimeState, GraphNodeType } from './types';
import type {
  UIContract,
  Capability,
  FeatureFlags,
  FlowContext,
  ActionSet,
  ActionDefinition,
  Intent,
  ProfileId,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

/**
 * UIContract generation parameters
 */
export interface UIContractGeneratorParams {
  /** Compiled node */
  compiledNode: CompiledNode;
  /** FlowID (stategeneratefor) */
  flowId: string;
  /** RuntimeState (for collected data lookup) */
  runtimeState?: Partial<RuntimeState>;
  /** FlowContext (user/client information) */
  flowContext?: Partial<FlowContext>;
  /** profile ID */
  profileId?: ProfileId;
}

// =============================================================================
// UIContractGenerator
// =============================================================================

/**
 * UIContractGenerator - UIContract generation
 */
export class UIContractGenerator {
  /**
   * Generate a UIContract
   *
   * @param params - generateparameters
   * @returns UIContract
   */
  generate(params: UIContractGeneratorParams): UIContract {
    const { compiledNode, flowId, runtimeState, flowContext, profileId } = params;

    // Generate the state string: {flowId}:{nodeId}
    const state = `${flowId}:${compiledNode.id}`;

    // Build FeatureFlags
    const features = this.buildFeatureFlags(profileId || 'human-basic');

    // Convert capabilities
    const capabilities = this.buildCapabilities(compiledNode);

    // Build FlowContext
    const context = this.buildFlowContext(flowContext, runtimeState);

    // Build ActionSet
    const actions = this.buildActionSet(compiledNode.type, compiledNode.intent);

    return {
      version: '0.1',
      state,
      intent: compiledNode.intent as Intent,
      features,
      capabilities,
      context,
      actions,
    };
  }

  /**
   * Build FeatureFlags
   */
  private buildFeatureFlags(profileId: ProfileId): FeatureFlags {
    // Profile-specific FeatureFlags settings
    const profileConfigs: Record<string, FeatureFlags> = {
      'human-basic': {
        policy: {
          rbac: 'simple',
          abac: false,
          rebac: false,
        },
        targets: {
          human: true,
          iot: false,
          ai_agent: false,
          ai_mcp: false,
          service: false,
        },
        authMethods: {
          passkey: true,
          email_code: true,
          password: false,
          external_idp: false,
          did: false,
        },
      },
      'human-org': {
        policy: {
          rbac: 'full',
          abac: false,
          rebac: true,
        },
        targets: {
          human: true,
          iot: false,
          ai_agent: false,
          ai_mcp: false,
          service: false,
        },
        authMethods: {
          passkey: true,
          email_code: true,
          password: false,
          external_idp: true,
          did: false,
        },
      },
      'ai-agent': {
        policy: {
          rbac: 'full',
          abac: true,
          rebac: true,
        },
        targets: {
          human: false,
          iot: false,
          ai_agent: true,
          ai_mcp: true,
          service: false,
        },
        authMethods: {
          passkey: true,
          email_code: false,
          password: false,
          external_idp: false,
          did: true,
        },
      },
      'iot-device': {
        policy: {
          rbac: 'simple',
          abac: true,
          rebac: false,
        },
        targets: {
          human: false,
          iot: true,
          ai_agent: false,
          ai_mcp: false,
          service: false,
        },
        authMethods: {
          passkey: false,
          email_code: false,
          password: false,
          external_idp: false,
          did: true,
        },
      },
    };

    // Default is human-basic
    return profileConfigs[profileId] || profileConfigs['human-basic'];
  }

  /**
   * Convert ResolvedCapability to Capability
   */
  private buildCapabilities(compiledNode: CompiledNode): Capability[] {
    return compiledNode.capabilities.map((resolved) => ({
      type: resolved.type,
      id: resolved.id,
      stability: resolved.stability,
      required: resolved.required,
      hints: resolved.hints,
      validation: resolved.validationRules,
    }));
  }

  /**
   * Build FlowContext
   */
  private buildFlowContext(
    flowContext?: Partial<FlowContext>,
    runtimeState?: Partial<RuntimeState>
  ): FlowContext {
    const context: FlowContext = {};

    // Copy information from flowContext
    if (flowContext) {
      if (flowContext.branding) context.branding = flowContext.branding;
      if (flowContext.user) context.user = flowContext.user;
      if (flowContext.organization) context.organization = flowContext.organization;
      if (flowContext.client) context.client = flowContext.client;
      if (flowContext.error) context.error = flowContext.error;
      if (flowContext.locale) context.locale = flowContext.locale;
    }

    // Fill authenticated user information from runtimeState
    if (runtimeState?.userId && !context.user) {
      context.user = {
        id: runtimeState.userId,
      };
    }

    // Fill email and related fields from runtimeState
    if (runtimeState?.collectedData) {
      const email = (runtimeState.collectedData as Record<string, unknown>)['identifier_email'];
      if (email && typeof email === 'object' && 'email' in email) {
        if (!context.user) {
          context.user = { id: 'pending' };
        }
        context.user.email = (email as { email: string }).email;
      }
    }

    return context;
  }

  /**
   * Build ActionSet
   */
  private buildActionSet(nodeType: GraphNodeType, intent: string): ActionSet {
    const primary = this.getPrimaryAction(nodeType, intent);
    const secondary = this.getSecondaryActions(nodeType, intent);

    return {
      primary,
      secondary: secondary.length > 0 ? secondary : undefined,
    };
  }

  /**
   * Get the primary action
   */
  private getPrimaryAction(nodeType: GraphNodeType, intent: string): ActionDefinition {
    // Primary action by node type / intent
    switch (nodeType) {
      case 'start':
        return { type: 'CONTINUE', label: 'Get Started' };

      case 'identifier':
        return { type: 'SUBMIT', label: 'Continue' };

      case 'auth_method':
        return { type: 'SUBMIT', label: 'Sign in' };

      case 'mfa':
        return { type: 'SUBMIT', label: 'Verify' };

      case 'consent':
        return { type: 'SUBMIT', label: 'Allow' };

      case 'end':
        return { type: 'COMPLETE', label: 'Done' };

      case 'error':
        return { type: 'RETRY', label: 'Try again' };

      default:
        return { type: 'SUBMIT', label: 'Continue' };
    }
  }

  /**
   * Get secondary actions
   */
  private getSecondaryActions(nodeType: GraphNodeType, intent: string): ActionDefinition[] {
    const actions: ActionDefinition[] = [];

    // Provide a BACK action for most nodes
    if (nodeType !== 'start' && nodeType !== 'end') {
      actions.push({
        type: 'BACK',
        label: 'Back',
        variant: 'secondary',
      });
    }

    // Add a Deny action for consent nodes
    if (nodeType === 'consent') {
      actions.push({
        type: 'DENY',
        label: 'Deny',
        variant: 'secondary',
      });
    }

    // Add a Cancel action for error nodes
    if (nodeType === 'error') {
      actions.push({
        type: 'CANCEL',
        label: 'Cancel',
        variant: 'secondary',
      });
    }

    return actions;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a UIContractGenerator
 *
 * @returns UIContractGenerator instance
 *
 * @example
 * const generator = createUIContractGenerator();
 * const uiContract = generator.generate({
 *   compiledNode,
 *   flowId: 'human-basic-login',
 *   runtimeState,
 * });
 */
export function createUIContractGenerator(): UIContractGenerator {
  return new UIContractGenerator();
}

// =============================================================================
// Export
// =============================================================================

export default UIContractGenerator;
