import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import type {
  DiscardedRuleSummary,
  EffectiveFieldMappingSetInput,
  EffectiveFieldMappingSetResult,
  FieldMappingRule,
  PolicyMergeTraceEntry,
  PolicyScopeKind,
} from './types';

const SCOPE_PRIORITY: Record<PolicyScopeKind, number> = {
  platform: 0,
  tenant: 1,
  source: 2,
  destination: 3,
  job: 4,
};

export function resolveEffectiveFieldMappingSet(
  input: EffectiveFieldMappingSetInput
): EffectiveFieldMappingSetResult {
  const rules = input.sets.flatMap((policy) => policy.rules);
  const groups = groupRulesByTarget(rules);
  const selected: FieldMappingRule[] = [];
  const discarded: FieldMappingRule[] = [];

  for (const group of groups.values()) {
    const [winner, ...rest] = [...group].sort(compareRules);
    if (winner) {
      selected.push(winner);
    }
    discarded.push(...rest);
  }

  selected.sort(compareRules);

  return {
    mergedSet: { id: 'effective', rules: selected },
    mergeTrace: [
      ...selected.map(
        (rule): PolicyMergeTraceEntry => ({
          ruleId: rule.id,
          scope: rule.scope,
          selected: true,
          reason:
            rule.action === 'deny' || rule.action === 'lock'
              ? reason('policy.deny_locked')
              : reason('policy.rule_selected'),
        })
      ),
      ...discarded.map(
        (rule): PolicyMergeTraceEntry => ({
          ruleId: rule.id,
          scope: rule.scope,
          selected: false,
          reason: reason('policy.rule_discarded'),
        })
      ),
    ],
    discardedRuleSummary: discarded.map(
      (rule): DiscardedRuleSummary => ({
        ruleId: rule.id,
        reason: reason('policy.rule_discarded'),
      })
    ),
  };
}

function groupRulesByTarget(rules: FieldMappingRule[]): Map<string, FieldMappingRule[]> {
  const groups = new Map<string, FieldMappingRule[]>();

  for (const rule of rules) {
    const key = targetKey(rule);
    const group = groups.get(key) ?? [];
    group.push(rule);
    groups.set(key, group);
  }

  return groups;
}

function targetKey(rule: FieldMappingRule): string {
  if (!rule.targetRef) {
    return '*';
  }
  return rule.targetRef.catalogEntryId
    ? `id:${rule.targetRef.catalogEntryId}`
    : `${rule.targetRef.side}:${rule.targetRef.namespace}:${rule.targetRef.path}`;
}

function compareRules(left: FieldMappingRule, right: FieldMappingRule): number {
  const leftDeny = left.action === 'deny' || left.action === 'lock' ? 1 : 0;
  const rightDeny = right.action === 'deny' || right.action === 'lock' ? 1 : 0;
  if (leftDeny !== rightDeny) {
    return rightDeny - leftDeny;
  }

  const scope = SCOPE_PRIORITY[right.scope.kind] - SCOPE_PRIORITY[left.scope.kind];
  if (scope !== 0) {
    return scope;
  }

  const specificity = (right.specificity ?? 0) - (left.specificity ?? 0);
  if (specificity !== 0) {
    return specificity;
  }

  const priority = (right.priority ?? 0) - (left.priority ?? 0);
  if (priority !== 0) {
    return priority;
  }

  return left.id.localeCompare(right.id);
}

export function fieldMappingTraceForRule(rule: FieldMappingRule) {
  return buildTraceEntry({
    reason:
      rule.action === 'deny' || rule.action === 'lock'
        ? reason('policy.deny_locked')
        : reason('policy.rule_selected'),
    ruleId: rule.id,
  });
}
