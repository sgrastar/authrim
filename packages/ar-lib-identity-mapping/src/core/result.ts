import type { MappingResultStatus, ReasonCode } from './types';

export function statusFromReasons(reasons: ReasonCode[]): MappingResultStatus {
  if (reasons.some((item) => item.severity === 'critical')) {
    return 'failed';
  }
  if (reasons.some((item) => item.severity === 'error' || item.severity === 'warning')) {
    return 'partial';
  }
  return 'success';
}
