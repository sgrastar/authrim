import type { AuditProfile, AuditTarget, Env, RuntimeProfile } from '@authrim/ar-lib-core';
import { resolveHyperdriveBindingForAuditTarget, targetToBackendId } from '@authrim/ar-lib-core';

export type RuntimeProfileReferenceResolution =
  | 'configured'
  | 'not_configured'
  | 'reference_only'
  | 'inline_config';

export type RuntimeProfileReferenceSeverity = 'info' | 'warning' | 'error';
export type RuntimeProfileReferenceActivation = 'ready' | 'warning_only' | 'blocked';

export interface RuntimeProfileReferenceManagementPolicy {
  mode: 'setup_only';
  future: 'admin_ui_planned';
  activationPolicy: 'save_ok_activate_ng';
  note: string;
}

export interface RuntimeProfileReferenceStatusEntry {
  path: string;
  type: string;
  resolution: RuntimeProfileReferenceResolution;
  severity: RuntimeProfileReferenceSeverity;
  activation: RuntimeProfileReferenceActivation;
  bindingRef?: string;
  connectionRef?: string;
  reference?: string;
  reason?: string;
}

export interface RuntimeProfileActivationStatus {
  state: 'ready' | 'warning' | 'blocked';
  activatable: boolean;
  severity: RuntimeProfileReferenceSeverity;
  blockingReasons: string[];
  warnings: string[];
}

export interface RuntimeProfileReferenceCatalog {
  bindingRefs: {
    d1: string[];
    r2: string[];
    hyperdrive: string[];
    all: string[];
  };
  connectionRefs: {
    all: string[];
  };
}

export const RUNTIME_PROFILE_REFERENCE_MANAGEMENT_POLICY: RuntimeProfileReferenceManagementPolicy =
  {
    mode: 'setup_only',
    future: 'admin_ui_planned',
    activationPolicy: 'save_ok_activate_ng',
    note: 'bindingRef and connectionRef resources are provisioned through setup today. Admin APIs may store profile references, but default activation is rejected when required runtime references are unresolved.',
  };

function registeredSchemaReferences(env: Env): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(env.AUTHRIM_REGISTERED_SCHEMA_REFS ?? '[]') as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []
    );
  } catch {
    return new Set();
  }
}

function registrationKeys(
  target: { bindingRef?: string; connectionRef?: string },
  streamId: string
): string[] {
  return [
    ...(target.bindingRef ? [`binding:${target.bindingRef}:${streamId}`] : []),
    ...(target.connectionRef ? [`connection:${target.connectionRef}:${streamId}`] : []),
  ];
}

const AUDIT_BACKEND_MIGRATION_STREAMS: Readonly<Record<string, string>> = {
  'd1-core': 'core-d1',
  'd1-pii': 'pii-d1',
  'd1-admin': 'admin-d1',
};

function blockUnregisteredDatabaseTargets(
  env: Env,
  profile: RuntimeProfile,
  entries: RuntimeProfileReferenceStatusEntry[]
): RuntimeProfileReferenceStatusEntry[] {
  if (profile.builtin) return entries;
  const registered = registeredSchemaReferences(env);

  const requiredByPath = new Map<string, { streamId: string | null; keys: string[] }>();
  if (profile.kind === 'audit') {
    const audit = profile as AuditProfile;
    const targets = [
      ...(audit.primary ? ([['primary', audit.primary]] as const) : []),
      ...(audit.archive ? ([['archive', audit.archive]] as const) : []),
      ...audit.sinks.map((target, index) => [`sinks[${index}]`, target] as const),
    ];
    for (const [path, target] of targets) {
      if (target.type !== 'd1' && target.type !== 'postgres' && target.type !== 'mysql') continue;
      const backendId = target.type === 'd1' ? targetToBackendId(target) : null;
      const streamId = backendId ? (AUDIT_BACKEND_MIGRATION_STREAMS[backendId] ?? null) : null;
      requiredByPath.set(path, {
        streamId,
        keys: streamId ? registrationKeys(target, streamId) : [],
      });
    }
  }

  return entries.map((entry) => {
    const required = requiredByPath.get(entry.path);
    if (!required || entry.activation === 'blocked') return entry;
    const registeredTarget = required.keys.some((key) => registered.has(key));
    if (required.streamId && registeredTarget) return entry;
    return {
      ...entry,
      severity: 'error',
      activation: 'blocked',
      reason: required.streamId
        ? `Database target is not registered with setup for release stream ${required.streamId}.`
        : `No published release migration stream is registered for this ${entry.type} database target.`,
    };
  });
}

function createEntry(
  entry: RuntimeProfileReferenceStatusEntry
): RuntimeProfileReferenceStatusEntry {
  return entry;
}

function getEnvBinding(env: Env, ref: string | undefined): unknown {
  if (!ref) {
    return undefined;
  }
  return (env as unknown as Record<string, unknown>)[ref];
}

function isD1DatabaseLike(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { prepare?: unknown }).prepare === 'function'
  );
}

function isR2BucketLike(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { put?: unknown }).put === 'function'
  );
}

function isHyperdriveLike(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { connectionString?: unknown }).connectionString === 'string'
  );
}

function deriveConnectionAliasesFromBinding(ref: string): string[] {
  const trimmed = ref.trim();
  if (!trimmed) {
    return [];
  }

  const withoutPrefix = trimmed.startsWith('HYPERDRIVE_')
    ? trimmed.slice('HYPERDRIVE_'.length)
    : trimmed;
  const dashed = withoutPrefix.toLowerCase().replace(/_+/g, '-');
  return [...new Set([trimmed, dashed])].filter(Boolean);
}

function describeAuditTarget(
  env: Env,
  path: string,
  target: AuditTarget
): RuntimeProfileReferenceStatusEntry {
  if (target.type === 'd1') {
    if (target.bindingRef) {
      if (getEnvBinding(env, target.bindingRef)) {
        return createEntry({
          path,
          type: target.type,
          resolution: 'configured',
          severity: 'info',
          activation: 'ready',
          bindingRef: target.bindingRef,
          ...(target.connectionRef ? { connectionRef: target.connectionRef } : {}),
        });
      }

      return createEntry({
        path,
        type: target.type,
        resolution: 'not_configured',
        severity: 'error',
        activation: 'blocked',
        bindingRef: target.bindingRef,
        ...(target.connectionRef ? { connectionRef: target.connectionRef } : {}),
        reason: `Runtime binding ${target.bindingRef} is not configured for this D1 audit target.`,
      });
    }

    if (target.connectionRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'reference_only',
        severity: 'warning',
        activation: 'blocked',
        connectionRef: target.connectionRef,
        reason: `D1 audit targets require a runtime binding. connectionRef ${target.connectionRef} is not runtime-resolved.`,
      });
    }

    return createEntry({
      path,
      type: target.type,
      resolution: 'not_configured',
      severity: 'error',
      activation: 'blocked',
      reason: 'D1 audit target is missing both bindingRef and connectionRef.',
    });
  }

  if (target.type === 'postgres' || target.type === 'mysql') {
    if (target.bindingRef && getEnvBinding(env, target.bindingRef)) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'configured',
        severity: 'info',
        activation: 'ready',
        bindingRef: target.bindingRef,
        ...(target.connectionRef ? { connectionRef: target.connectionRef } : {}),
      });
    }

    if (resolveHyperdriveBindingForAuditTarget(env as unknown as Record<string, unknown>, target)) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'configured',
        severity: 'info',
        activation: 'ready',
        ...(target.bindingRef ? { bindingRef: target.bindingRef } : {}),
        ...(target.connectionRef ? { connectionRef: target.connectionRef } : {}),
      });
    }

    if (target.bindingRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'not_configured',
        severity: 'error',
        activation: 'blocked',
        bindingRef: target.bindingRef,
        ...(target.connectionRef ? { connectionRef: target.connectionRef } : {}),
        reason: target.connectionRef
          ? `Neither bindingRef ${target.bindingRef} nor connectionRef ${target.connectionRef} resolved to a runtime Hyperdrive binding.`
          : `Runtime binding ${target.bindingRef} is not configured for this ${target.type} audit target.`,
      });
    }

    if (target.connectionRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'reference_only',
        severity: 'warning',
        activation: 'blocked',
        connectionRef: target.connectionRef,
        reason: `Audit connectionRef ${target.connectionRef} did not resolve to a runtime Hyperdrive binding.`,
      });
    }

    return createEntry({
      path,
      type: target.type,
      resolution: 'not_configured',
      severity: 'error',
      activation: 'blocked',
      reason: `${target.type} audit target is missing both bindingRef and connectionRef.`,
    });
  }

  if (target.type === 'r2') {
    const configured = Boolean(getEnvBinding(env, target.bucketRef));
    return createEntry({
      path,
      type: target.type,
      resolution: configured ? 'configured' : 'not_configured',
      severity: configured ? 'info' : 'error',
      activation: configured ? 'ready' : 'blocked',
      reference: target.bucketRef,
      ...(configured
        ? {}
        : {
            reason: `Archive bucket binding ${target.bucketRef} is not configured in the runtime environment.`,
          }),
    });
  }

  if (target.type === 'http') {
    const resolvedUrl = target.url
      ? true
      : Boolean(target.urlRef && getEnvBinding(env, target.urlRef));
    const missingUrlRef = Boolean(target.urlRef && !getEnvBinding(env, target.urlRef));
    const missingAuthTokenRef = Boolean(
      target.authTokenRef && !getEnvBinding(env, target.authTokenRef)
    );

    if (resolvedUrl && !missingAuthTokenRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: target.url ? 'inline_config' : 'configured',
        severity: 'info',
        activation: 'ready',
        ...(target.urlRef ? { reference: target.urlRef } : {}),
      });
    }

    if (missingUrlRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'not_configured',
        severity: 'error',
        activation: 'blocked',
        reference: target.urlRef,
        reason: `HTTP sink urlRef ${target.urlRef} is not configured in the runtime environment.`,
      });
    }

    if (missingAuthTokenRef) {
      return createEntry({
        path,
        type: target.type,
        resolution: 'not_configured',
        severity: 'error',
        activation: 'blocked',
        reference: target.authTokenRef,
        reason: `HTTP sink authTokenRef ${target.authTokenRef} is not configured in the runtime environment.`,
      });
    }

    return createEntry({
      path,
      type: target.type,
      resolution: target.urlRef || target.authTokenRef ? 'reference_only' : 'not_configured',
      severity: target.urlRef || target.authTokenRef ? 'warning' : 'error',
      activation: 'blocked',
      reference: target.urlRef ?? target.authTokenRef,
      reason:
        target.urlRef || target.authTokenRef
          ? 'HTTP sink references are incomplete in the current runtime environment.'
          : 'HTTP audit target is missing both url and urlRef.',
    });
  }

  if (target.type === 'logpush') {
    return createEntry({
      path,
      type: target.type,
      resolution: 'reference_only',
      severity: 'warning',
      activation: 'warning_only',
      reference: target.destinationRef,
      reason: `Logpush destinationRef ${target.destinationRef} is setup-managed and is not runtime-introspectable.`,
    });
  }

  if (target.type === 'firehose') {
    return createEntry({
      path,
      type: target.type,
      resolution: 'reference_only',
      severity: 'warning',
      activation: 'warning_only',
      reference: target.streamRef,
      reason: `Firehose streamRef ${target.streamRef} is setup-managed and is not runtime-introspectable.`,
    });
  }

  return createEntry({
    path: `${path}.unsupported`,
    type: target.type,
    resolution: 'not_configured',
    severity: 'error',
    activation: 'blocked',
    reason: `Unsupported audit target type ${(target as { type: string }).type}.`,
  });
}

export function describeRuntimeProfileReferenceStatus(
  env: Env,
  profile: RuntimeProfile
): RuntimeProfileReferenceStatusEntry[] {
  if (profile.kind === 'audit') {
    const auditProfile = profile as AuditProfile;
    return blockUnregisteredDatabaseTargets(env, profile, [
      ...(auditProfile.primary ? [describeAuditTarget(env, 'primary', auditProfile.primary)] : []),
      ...(auditProfile.archive ? [describeAuditTarget(env, 'archive', auditProfile.archive)] : []),
      ...auditProfile.sinks.map((sink, index) => describeAuditTarget(env, `sinks[${index}]`, sink)),
    ]);
  }

  return [];
}

export function describeRuntimeProfileActivationStatus(
  env: Env,
  profile: RuntimeProfile
): RuntimeProfileActivationStatus {
  if (profile.kind === 'residency') {
    return {
      state: 'ready',
      activatable: true,
      severity: 'info',
      blockingReasons: [],
      warnings: [],
    };
  }

  const entries = describeRuntimeProfileReferenceStatus(env, profile);
  const blockingReasons = entries
    .filter((entry) => entry.activation === 'blocked')
    .map((entry) => entry.reason ?? `${entry.path} is not ready for activation.`);
  const warnings = entries
    .filter((entry) => entry.severity === 'warning' || entry.activation === 'warning_only')
    .map((entry) => entry.reason ?? `${entry.path} requires operator verification.`);

  if (blockingReasons.length > 0) {
    return {
      state: 'blocked',
      activatable: false,
      severity: 'error',
      blockingReasons,
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      state: 'warning',
      activatable: true,
      severity: 'warning',
      blockingReasons: [],
      warnings,
    };
  }

  return {
    state: 'ready',
    activatable: true,
    severity: 'info',
    blockingReasons: [],
    warnings: [],
  };
}

export function buildRuntimeProfileReferenceCatalog(
  env: Env,
  profiles: RuntimeProfile[]
): RuntimeProfileReferenceCatalog {
  const d1Bindings = new Set<string>();
  const r2Bindings = new Set<string>();
  const hyperdriveBindings = new Set<string>();
  const connectionRefs = new Set<string>();

  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (isD1DatabaseLike(value)) {
      d1Bindings.add(key);
      continue;
    }
    if (isR2BucketLike(value)) {
      r2Bindings.add(key);
      continue;
    }
    if (isHyperdriveLike(value)) {
      hyperdriveBindings.add(key);
      for (const alias of deriveConnectionAliasesFromBinding(key)) {
        connectionRefs.add(alias);
      }
    }
  }

  const addBindingRef = (bindingRef: string | undefined, type: 'd1' | 'r2' | 'hyperdrive') => {
    if (!bindingRef) {
      return;
    }
    if (type === 'd1') {
      d1Bindings.add(bindingRef);
    } else if (type === 'r2') {
      r2Bindings.add(bindingRef);
    } else {
      hyperdriveBindings.add(bindingRef);
    }
  };

  const addConnectionRef = (connectionRef: string | undefined) => {
    if (connectionRef) {
      connectionRefs.add(connectionRef);
    }
  };

  for (const profile of profiles) {
    if (profile.kind === 'audit') {
      const auditProfile = profile as AuditProfile;
      const targets: Array<AuditTarget | null | undefined> = [
        auditProfile.primary,
        auditProfile.archive,
        ...auditProfile.sinks,
      ];
      for (const target of targets) {
        if (!target) {
          continue;
        }
        if (target.type === 'd1') {
          addBindingRef(target.bindingRef, 'd1');
        } else if (target.type === 'r2') {
          addBindingRef(target.bucketRef, 'r2');
        } else if (target.type === 'postgres' || target.type === 'mysql') {
          addBindingRef(target.bindingRef, 'hyperdrive');
          addConnectionRef(target.connectionRef);
        }
      }
    }
  }

  return {
    bindingRefs: {
      d1: [...d1Bindings].sort(),
      r2: [...r2Bindings].sort(),
      hyperdrive: [...hyperdriveBindings].sort(),
      all: [...new Set([...d1Bindings, ...r2Bindings, ...hyperdriveBindings])].sort(),
    },
    connectionRefs: {
      all: [...connectionRefs].sort(),
    },
  };
}
