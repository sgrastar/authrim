import { evaluateAgentAuthorization, hasCompleteAgentConfigurationSnapshot } from './authorization';
import type {
  AgentActorContext,
  AgentAuthorizationDecision,
  AgentGrantContract,
  AgentResourceRequestContext,
  AgentRiskPolicy,
  AgentToolDefinition,
} from './types';

export interface LiveAgentAuthorizationDependencies {
  now(): number;
  isFeatureEnabled(tenantId: string): Promise<boolean>;
  getDelegatorPermissions(
    tenantId: string,
    delegatorId: string,
    now: number
  ): Promise<string[] | null>;
  getPrincipalPermissionLimit?(
    tenantId: string,
    principalId: string,
    credentialId: string | undefined,
    now: number
  ): Promise<string[] | null>;
  getRiskPolicy(tenantId: string): Promise<AgentRiskPolicy>;
  isConfigurationSnapshotActive?(
    tenantId: string,
    snapshot: {
      taskSetId: string;
      taskSetVersion: number;
      scopePolicyId: string;
      scopePolicyVersion: number;
    }
  ): Promise<boolean>;
}

export interface LiveAgentAuthorizationRequest {
  actor: AgentActorContext;
  grant: AgentGrantContract;
  tool: AgentToolDefinition;
  resource: AgentResourceRequestContext;
  elevationCapabilityValid?: boolean;
}

/** Re-evaluates mutable authorization inputs for every MCP operation. */
export class LiveAgentAuthorizationService {
  constructor(private readonly dependencies: LiveAgentAuthorizationDependencies) {}

  async authorize(input: LiveAgentAuthorizationRequest): Promise<AgentAuthorizationDecision> {
    const now = this.dependencies.now();
    try {
      const [featureEnabled, delegatorCurrentPermissions, riskPolicy] = await Promise.all([
        this.dependencies.isFeatureEnabled(input.grant.tenantId),
        this.dependencies.getDelegatorPermissions(
          input.grant.tenantId,
          input.grant.delegatorId,
          now
        ),
        this.dependencies.getRiskPolicy(input.grant.tenantId),
      ]);
      if (!delegatorCurrentPermissions) {
        return {
          allowed: false,
          requiresElevation: false,
          deniedAxis: 'permission',
          code: 'AGENT_DELEGATOR_INACTIVE',
        };
      }
      if (
        !hasCompleteAgentConfigurationSnapshot(input.grant) ||
        !this.dependencies.isConfigurationSnapshotActive
      ) {
        return {
          allowed: false,
          requiresElevation: false,
          deniedAxis: 'grant',
          code: 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE',
        };
      }
      const active = await this.dependencies.isConfigurationSnapshotActive(input.grant.tenantId, {
        taskSetId: input.grant.taskSetId,
        taskSetVersion: input.grant.taskSetVersion,
        scopePolicyId: input.grant.scopePolicyId,
        scopePolicyVersion: input.grant.scopePolicyVersion,
      });
      if (!active) {
        return {
          allowed: false,
          requiresElevation: false,
          deniedAxis: 'grant',
          code: 'AGENT_CONFIGURATION_SNAPSHOT_INACTIVE',
        };
      }
      let principalPermissionLimit: string[] | undefined;
      if (input.grant.machinePrincipalId) {
        const resolver = this.dependencies.getPrincipalPermissionLimit;
        if (!resolver) {
          return {
            allowed: false,
            requiresElevation: false,
            deniedAxis: 'identity',
            code: 'AGENT_PRINCIPAL_STATE_UNAVAILABLE',
          };
        }
        const resolved = await resolver(
          input.grant.tenantId,
          input.grant.machinePrincipalId,
          input.actor.machineCredentialId,
          now
        );
        if (!resolved) {
          return {
            allowed: false,
            requiresElevation: false,
            deniedAxis: 'identity',
            code: 'AGENT_PRINCIPAL_INACTIVE',
          };
        }
        principalPermissionLimit = resolved;
      }
      return evaluateAgentAuthorization({
        featureEnabled,
        now,
        actor: input.actor,
        grant: input.grant,
        tool: input.tool,
        delegatorCurrentPermissions,
        principalPermissionLimit,
        constraints: input.grant.resolvedScopeConstraints,
        resource: input.resource,
        riskPolicy,
        elevationCapabilityValid: input.elevationCapabilityValid,
      });
    } catch {
      return {
        allowed: false,
        requiresElevation: false,
        deniedAxis: 'grant',
        code: 'AGENT_AUTHORIZATION_STATE_UNAVAILABLE',
      };
    }
  }
}
