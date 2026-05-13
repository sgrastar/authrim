import type {
  ApprovalScopeDescriptor,
  ApprovalScopeJson,
  StructuredReference,
} from '../types/approval';

type JsonObject = Record<string, ApprovalScopeJson | undefined>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }

  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeScopeJson(value: ApprovalScopeJson | undefined): ApprovalScopeJson | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeScopeJson(entry))
      .filter((entry): entry is ApprovalScopeJson => entry !== undefined);
  }

  if (isPlainObject(value)) {
    const normalized: Record<string, ApprovalScopeJson> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const entry = normalizeScopeJson(value[key]);
      if (entry !== undefined) {
        normalized[key] = entry;
      }
    }
    return normalized;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function generateInvestigationId(): string {
  return `inv_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function generatePublicApprovalRequestId(): string {
  return `apr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function generatePublicElevationGrantId(): string {
  return `egr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function generatePublicApprovalCompletionArtifactId(): string {
  return `apc_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function generatePublicApprovalDecisionReceiptId(): string {
  return `adr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function normalizeStructuredReference(
  input: string | StructuredReference | null | undefined,
  options?: { defaultSystem?: string }
): StructuredReference | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    const id = input.trim();
    if (!id) {
      return null;
    }
    return {
      system: options?.defaultSystem ?? 'external',
      id,
    };
  }

  const system = input.system?.trim();
  const id = input.id?.trim();
  if (!system || !id) {
    return null;
  }

  return {
    system,
    id,
    ...(input.url?.trim() ? { url: input.url.trim() } : {}),
  };
}

export function canonicalizeApprovalScope(scope: ApprovalScopeDescriptor): {
  normalized: ApprovalScopeDescriptor;
  canonical: string;
} {
  const normalized: ApprovalScopeDescriptor = {
    version: 1,
    surface: scope.surface.trim(),
    action: scope.action.trim(),
    tenant_id: scope.tenant_id.trim(),
    resource_class: scope.resource_class.trim(),
    ...(normalizeStringArray(scope.resource_ids) && {
      resource_ids: normalizeStringArray(scope.resource_ids),
    }),
    ...(normalizeStringArray(scope.detail_classes) && {
      detail_classes: normalizeStringArray(scope.detail_classes),
    }),
    ...(scope.dataset?.trim() ? { dataset: scope.dataset.trim() } : {}),
    ...(scope.audience?.trim() ? { audience: scope.audience.trim() } : {}),
    ...(scope.investigation_id?.trim() ? { investigation_id: scope.investigation_id.trim() } : {}),
    ...(scope.redaction_level ? { redaction_level: scope.redaction_level } : {}),
    ...(normalizeScopeJson(scope.attributes) && {
      attributes: normalizeScopeJson(scope.attributes) as Record<string, ApprovalScopeJson>,
    }),
  };

  return {
    normalized,
    canonical: stableStringify(normalized),
  };
}
