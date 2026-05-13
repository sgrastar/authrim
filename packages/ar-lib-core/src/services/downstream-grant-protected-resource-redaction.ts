import type {
  DownstreamGrantServiceAuthorizationResult,
  DownstreamGrantServiceDecision,
} from './downstream-elevation-grant';
import type { ApprovalRedactionLevel } from '../types/approval';

export interface DownstreamGrantProtectedResourceProjectionInput<Resource> {
  resource: Resource;
  redactionLevel: ApprovalRedactionLevel;
}

export interface DownstreamGrantProtectedResourceProjector<
  Resource,
  SummaryView,
  MaskedView = SummaryView,
  RawView = MaskedView,
> {
  summary: (resource: Resource) => SummaryView;
  masked?: (resource: Resource) => MaskedView;
  raw?: (resource: Resource) => RawView;
}

export function getDownstreamGrantRedactionLevel(input: {
  authorization?: Pick<DownstreamGrantServiceAuthorizationResult, 'redactionLevel'> | null;
  decision?: Pick<DownstreamGrantServiceDecision, 'context'> | null;
  fallback?: ApprovalRedactionLevel;
}): ApprovalRedactionLevel {
  return (
    input.authorization?.redactionLevel ??
    input.decision?.context.redactionLevel ??
    input.fallback ??
    'masked'
  );
}

export function projectDownstreamGrantProtectedResource<
  Resource,
  SummaryView,
  MaskedView = SummaryView,
  RawView = MaskedView,
>(
  input: DownstreamGrantProtectedResourceProjectionInput<Resource>,
  projector: DownstreamGrantProtectedResourceProjector<Resource, SummaryView, MaskedView, RawView>
): SummaryView | MaskedView | RawView {
  if (input.redactionLevel === 'summary_only') {
    return projector.summary(input.resource);
  }
  if (input.redactionLevel === 'masked') {
    return projector.masked ? projector.masked(input.resource) : projector.summary(input.resource);
  }
  if (projector.raw) {
    return projector.raw(input.resource);
  }
  if (projector.masked) {
    return projector.masked(input.resource);
  }
  return projector.summary(input.resource);
}
