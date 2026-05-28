import type {
  CanonicalIdentityRepository,
  IdentityBindingRow,
  IdentityResolutionCandidateRow,
  IdentityResolutionEventRow,
} from '../repositories/identity';
import { withoutRawIdentifiers, type IdentityBindingKeyResult } from './identity-identifier-bridge';

export const IDENTITY_RESOLUTION_REASON_CODES = {
  hardMatch: 'identity_resolution.hard_match',
  hardMatchMissing: 'identity_resolution.hard_match_missing',
  candidateGenerationDisabled: 'identity_resolution.candidate_generation_disabled',
  candidateGenerated: 'identity_resolution.candidate_generated',
} as const;

export type IdentityResolutionPolicy = 'hard_match_only' | 'candidate_generation';

export interface IdentityResolutionCandidateEvidence {
  candidateSubjectId?: string | null;
  candidateAccountId?: string | null;
  candidateBindingId?: string | null;
  score: number;
  riskTier?: string | null;
  reasonCodes?: string[] | null;
  reviewTaskId?: string | null;
  expiresAt?: number | null;
}

export interface ResolveIdentityBindingInput {
  bindingKey: IdentityBindingKeyResult;
  resolutionPolicy?: IdentityResolutionPolicy;
  candidateEvidence?: IdentityResolutionCandidateEvidence[];
  traceRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type ResolveIdentityBindingResult =
  | {
      outcome: 'matched';
      binding: IdentityBindingRow;
      event: IdentityResolutionEventRow;
      candidates: [];
    }
  | {
      outcome: 'review_required';
      binding: null;
      event: IdentityResolutionEventRow;
      candidates: IdentityResolutionCandidateRow[];
    }
  | {
      outcome: 'rejected';
      binding: null;
      event: IdentityResolutionEventRow;
      candidates: [];
    };

export async function resolveIdentityBinding(
  repository: CanonicalIdentityRepository,
  input: ResolveIdentityBindingInput
): Promise<ResolveIdentityBindingResult> {
  const binding = await repository.findBindingByProviderSubjectHash(
    input.bindingKey.protocol,
    input.bindingKey.sourceId,
    input.bindingKey.providerSubjectKeyHash
  );

  if (binding) {
    const event = await repository.recordResolutionEvent({
      subject_id: binding.subject_id,
      account_id: binding.account_id,
      binding_id: binding.id,
      source_id: input.bindingKey.sourceId,
      resolution_method: 'hard_match',
      outcome: 'matched',
      reason_codes: [IDENTITY_RESOLUTION_REASON_CODES.hardMatch],
      trace_ref: input.traceRef ?? null,
      metadata: sanitizeResolutionMetadata(input.metadata),
    });
    return {
      outcome: 'matched',
      binding,
      event,
      candidates: [],
    };
  }

  const policy = input.resolutionPolicy ?? 'hard_match_only';
  if (policy === 'candidate_generation' && input.candidateEvidence?.length) {
    const candidates: IdentityResolutionCandidateRow[] = [];
    for (const evidence of input.candidateEvidence) {
      candidates.push(
        await repository.createResolutionCandidate({
          source_id: input.bindingKey.sourceId,
          candidate_subject_id: evidence.candidateSubjectId ?? null,
          candidate_account_id: evidence.candidateAccountId ?? null,
          candidate_binding_id: evidence.candidateBindingId ?? null,
          candidate_score: evidence.score,
          risk_tier: evidence.riskTier ?? null,
          reason_codes: [
            IDENTITY_RESOLUTION_REASON_CODES.candidateGenerated,
            ...(evidence.reasonCodes ?? []),
          ],
          review_task_id: evidence.reviewTaskId ?? null,
          expires_at: evidence.expiresAt ?? null,
        })
      );
    }
    const event = await repository.recordResolutionEvent({
      source_id: input.bindingKey.sourceId,
      resolution_method: 'candidate_generation',
      outcome: 'review_required',
      reason_codes: [IDENTITY_RESOLUTION_REASON_CODES.candidateGenerated],
      trace_ref: input.traceRef ?? null,
      metadata: sanitizeResolutionMetadata(input.metadata),
    });
    return {
      outcome: 'review_required',
      binding: null,
      event,
      candidates,
    };
  }

  const event = await repository.recordResolutionEvent({
    source_id: input.bindingKey.sourceId,
    resolution_method: policy,
    outcome: 'rejected',
    reason_codes: [
      IDENTITY_RESOLUTION_REASON_CODES.hardMatchMissing,
      IDENTITY_RESOLUTION_REASON_CODES.candidateGenerationDisabled,
    ],
    trace_ref: input.traceRef ?? null,
    metadata: sanitizeResolutionMetadata(input.metadata),
  });
  return {
    outcome: 'rejected',
    binding: null,
    event,
    candidates: [],
  };
}

function sanitizeResolutionMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  return withoutRawIdentifiers(JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>);
}
