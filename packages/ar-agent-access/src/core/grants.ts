export type {
  AgentDelegationMode,
  AgentGrantContract,
  AgentGrantStatus,
  AgentGrantValidationInput,
  AgentGrantValidationResult,
  AgentPrincipalTenantScope,
  AgentTenantBoundaryInput,
} from './types';
export {
  principalExplicitlyAllowsTenant,
  validateAgentGrantPermissions,
  validateAgentTenantBoundary,
} from './authorization';
