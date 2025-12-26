/**
 * Contract Types - Three-Layer Policy Hierarchy
 *
 * This module exports TypeScript types for the Contract-based policy system.
 * All 15 settings categories are unified into the Tenant Policy → Client Profile → Flow hierarchy.
 *
 * External API names:
 * - TenantContract → TenantPolicy (GET /api/admin/tenant-policy)
 * - ClientContract → ClientProfile (GET /api/admin/clients/:id/profile)
 * - ResolvedPolicy → EffectivePolicy (GET /api/flow/effective-policy)
 *
 * @see ./tenant.ts - Tenant Contract (Policy) types
 * @see ./client.ts - Client Contract (Profile) types
 * @see ./resolved.ts - Resolved Policy types
 * @see ./presets.ts - Preset definitions
 * @see ./ui-display.ts - UI display types
 * @see ./common.ts - Common types (lifecycle, algorithms, etc.)
 * @see ./errors.ts - Error types and codes
 * @see ./resolver.ts - PolicyResolver interface
 * @see ./defaults.ts - Default values
 * @see ./cache.ts - Cache strategy types
 * @see ./change-log.ts - Change history and rollback
 * @see ./audit.ts - Audit log types
 * @see ./dependencies.ts - Dependency graph types
 * @see ./events.ts - Webhook and event types
 * @see ./oidc-core.ts - OIDC Core node constants
 */

// =============================================================================
// Core Contract Types
// =============================================================================
export * from './tenant';
export * from './client';
export * from './resolved';
export * from './presets';
export * from './common';

// =============================================================================
// UI Display Types
// =============================================================================
export * from './ui-display';

// =============================================================================
// Error Handling
// =============================================================================
export * from './errors';

// =============================================================================
// Policy Resolution
// =============================================================================
export * from './resolver';

// =============================================================================
// Default Values
// =============================================================================
export * from './defaults';

// =============================================================================
// Cache Management
// =============================================================================
export * from './cache';

// =============================================================================
// Change History & Rollback
// =============================================================================
export * from './change-log';

// =============================================================================
// Audit Logging
// =============================================================================
export * from './audit';

// =============================================================================
// Dependency Management
// =============================================================================
export * from './dependencies';

// =============================================================================
// Events & Webhooks
// =============================================================================
export * from './events';

// =============================================================================
// OIDC Core Nodes
// =============================================================================
export * from './oidc-core';

// External API type aliases
import type { TenantContract } from './tenant';
import type { ClientContract } from './client';
import type { ResolvedPolicy } from './resolved';

/**
 * External API type alias for TenantContract.
 * Used in API responses and SDK.
 */
export type TenantPolicy = TenantContract;

/**
 * External API type alias for ClientContract.
 * Used in API responses and SDK.
 */
export type ClientProfile = ClientContract;

/**
 * External API type alias for ResolvedPolicy.
 * Used in API responses and SDK.
 */
export type EffectivePolicy = ResolvedPolicy;
