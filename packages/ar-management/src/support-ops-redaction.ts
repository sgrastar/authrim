export interface RedactedCohortCounts {
  matched_count: number | null;
  actionable_count: number | null;
  blocked_count: number | null;
  blocked_reasons: string[];
  blocked_reasons_suppressed: boolean;
  privacy: {
    min_count: number;
    low_count_suppressed: boolean;
  };
}

export function isLowCount(value: number, minCount: number): boolean {
  return value > 0 && value < minCount;
}

export function redactCohortCounts(
  resource: { minCount: number },
  matchedCount: number,
  actionableCount: number,
  blockedCount: number,
  blockedReasons: string[] = []
): RedactedCohortCounts {
  const actionableSuppressed = isLowCount(actionableCount, resource.minCount);
  const blockedSuppressed = isLowCount(blockedCount, resource.minCount);
  const matchedSuppressed =
    isLowCount(matchedCount, resource.minCount) ||
    (actionableSuppressed && blockedCount > 0) ||
    (blockedSuppressed && actionableCount > 0);

  return {
    matched_count: matchedSuppressed ? null : matchedCount,
    actionable_count: actionableSuppressed ? null : actionableCount,
    blocked_count: blockedSuppressed ? null : blockedCount,
    blocked_reasons: blockedSuppressed ? [] : blockedReasons,
    blocked_reasons_suppressed: blockedSuppressed,
    privacy: {
      min_count: resource.minCount,
      low_count_suppressed: matchedSuppressed || actionableSuppressed || blockedSuppressed,
    },
  };
}

export function redactResultSummary(
  resource: { minCount: number },
  resultSummary: Record<string, unknown>,
  matchedCount: number,
  actionableCount: number,
  blockedCount: number
): Record<string, unknown> {
  const redacted = redactCohortCounts(resource, matchedCount, actionableCount, blockedCount);
  const outcomes = ['succeeded_count', 'failed_count'].filter((key) => key in resultSummary);
  const outcomeSuppressed =
    outcomes.length > 0 &&
    (redacted.actionable_count === null ||
      outcomes.some((key) => {
        const value = Number(resultSummary[key]);
        return !Number.isFinite(value) || isLowCount(value, resource.minCount);
      }));
  return {
    ...resultSummary,
    ...(outcomeSuppressed ? Object.fromEntries(outcomes.map((key) => [key, null])) : {}),
    matched_count: redacted.matched_count,
    attempted_count: redacted.actionable_count,
    blocked_count: redacted.blocked_count,
    blocked_reasons_suppressed: redacted.blocked_reasons_suppressed,
    privacy: {
      ...redacted.privacy,
      low_count_suppressed: redacted.privacy.low_count_suppressed || outcomeSuppressed,
    },
  };
}
