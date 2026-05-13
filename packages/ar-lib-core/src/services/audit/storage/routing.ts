import type {
  AuditLogType,
  AuditRetentionConfig,
  AuditStorageConfig,
  AuditStorageRoutingRule,
} from './adapter';
import { hasAuditStorageRoutingTargets, normalizeAuditStorageRoutingTargets } from './adapter';

export interface AuditRoutingContext {
  tenantId: string;
  logType: AuditLogType;
  clientId?: string;
  eventCategory?: string;
  region?: string;
}

export interface ResolvedAuditRoutingTargets {
  primaryStore: string;
  archiveStores: string[];
  forwardingSinks: string[];
  retention: Partial<AuditRetentionConfig>;
  matchedRuleNames: string[];
}

function matchesRuleValue(
  actual: string | undefined,
  expected: string | string[] | AuditLogType | '*'
): boolean {
  if (expected === '*') {
    return true;
  }

  if (Array.isArray(expected)) {
    return actual !== undefined && expected.includes(actual);
  }

  return actual !== undefined && actual === expected;
}

export function auditRoutingRuleMatches(
  rule: AuditStorageRoutingRule,
  context: AuditRoutingContext
): boolean {
  const conditions = rule.conditions;

  if (conditions.tenantId && !matchesRuleValue(context.tenantId, conditions.tenantId)) {
    return false;
  }
  if (conditions.clientId && !matchesRuleValue(context.clientId, conditions.clientId)) {
    return false;
  }
  if (conditions.logType && !matchesRuleValue(context.logType, conditions.logType)) {
    return false;
  }
  if (
    conditions.eventCategory &&
    !matchesRuleValue(context.eventCategory, conditions.eventCategory)
  ) {
    return false;
  }
  if (conditions.region && !matchesRuleValue(context.region, conditions.region)) {
    return false;
  }

  return true;
}

function mergeUnique(target: string[], additions: string[] | undefined): void {
  if (!additions) {
    return;
  }

  for (const value of additions) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

/**
 * Resolve the effective routing targets for one audit log write.
 *
 * Semantics:
 * - The default backend for the log type is always the starting primary store.
 * - Matching rules are evaluated in ascending priority order.
 * - The first matching rule that specifies `primaryStore` overrides the default primary.
 * - Matching archive stores and forwarding sinks are unioned across all matching rules.
 * - Retention overrides use first-wins semantics per field.
 */
export function resolveAuditRoutingTargets(
  config: AuditStorageConfig,
  context: AuditRoutingContext
): ResolvedAuditRoutingTargets {
  const sortedRules = [...config.routingRules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority);

  const resolved: ResolvedAuditRoutingTargets = {
    primaryStore:
      context.logType === 'event' ? config.defaultEventBackend : config.defaultPiiBackend,
    archiveStores: [],
    forwardingSinks: [],
    retention: {},
    matchedRuleNames: [],
  };

  let primaryOverridden = false;

  for (const rule of sortedRules) {
    if (!auditRoutingRuleMatches(rule, context)) {
      continue;
    }

    const targets = normalizeAuditStorageRoutingTargets(rule.targets, rule.backend);
    if (!hasAuditStorageRoutingTargets(targets)) {
      continue;
    }

    resolved.matchedRuleNames.push(rule.name);

    if (!primaryOverridden && targets.primaryStore) {
      resolved.primaryStore = targets.primaryStore;
      primaryOverridden = true;
    }

    mergeUnique(resolved.archiveStores, targets.archiveStores);
    mergeUnique(resolved.forwardingSinks, targets.forwardingSinks);

    if (rule.retention?.eventLogRetentionDays !== undefined) {
      resolved.retention.eventLogRetentionDays ??= rule.retention.eventLogRetentionDays;
    }
    if (rule.retention?.piiLogRetentionDays !== undefined) {
      resolved.retention.piiLogRetentionDays ??= rule.retention.piiLogRetentionDays;
    }
    if (rule.retention?.archiveBeforeDelete !== undefined) {
      resolved.retention.archiveBeforeDelete ??= rule.retention.archiveBeforeDelete;
    }
    if (rule.retention?.minimumRetentionDays !== undefined) {
      resolved.retention.minimumRetentionDays ??= rule.retention.minimumRetentionDays;
    }
  }

  return resolved;
}
