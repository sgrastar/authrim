/**
 * Policy Infrastructure
 *
 * Exports policy infrastructure implementations.
 */

// Built-in ReBAC implementation
export { BuiltinPolicyInfra } from './builtin';

// Factory function
export { createPolicyInfra, type PolicyInfraOptions } from './factory';
