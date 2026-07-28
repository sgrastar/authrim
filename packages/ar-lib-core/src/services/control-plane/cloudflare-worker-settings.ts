export type CloudflareControlTokenKind = 'd1' | 'workers' | 'kv' | 'r2';

export type CloudflareControlOperation =
  | 'd1.create'
  | 'd1.delete'
  | 'd1.get'
  | 'd1.import'
  | 'd1.list'
  | 'd1.query'
  | 'd1.raw'
  | 'd1.update'
  | 'workers.deployment.create'
  | 'workers.deployment.list'
  | 'workers.script.delete'
  | 'workers.settings.get'
  | 'workers.settings.patch'
  | 'workers.version.list'
  | 'kv.namespace.create'
  | 'kv.namespace.delete'
  | 'kv.namespace.list'
  | 'r2.bucket.create'
  | 'r2.bucket.delete'
  | 'r2.bucket.list';

export interface CloudflareControlTokens {
  d1?: string | null;
  workers?: string | null;
  kv?: string | null;
  r2?: string | null;
}

export interface CloudflareWorkerBinding extends Record<string, unknown> {
  name: string;
  type: string;
}

export interface CloudflareWorkerSettings extends Record<string, unknown> {
  bindings?: CloudflareWorkerBinding[];
}

export interface CloudflareWorkerInheritBinding extends CloudflareWorkerBinding {
  type: 'inherit';
  version_id: string;
}

export interface WorkerSettingsPreservationIssue {
  field: string;
  reason: 'missing' | 'changed' | 'unexpected';
}

const TOKEN_KIND_BY_OPERATION: Readonly<
  Record<CloudflareControlOperation, CloudflareControlTokenKind>
> = {
  'd1.create': 'd1',
  'd1.delete': 'd1',
  'd1.get': 'd1',
  'd1.import': 'd1',
  'd1.list': 'd1',
  'd1.query': 'd1',
  'd1.raw': 'd1',
  'd1.update': 'd1',
  'workers.deployment.create': 'workers',
  'workers.deployment.list': 'workers',
  'workers.script.delete': 'workers',
  'workers.settings.get': 'workers',
  'workers.settings.patch': 'workers',
  'workers.version.list': 'workers',
  'kv.namespace.create': 'kv',
  'kv.namespace.delete': 'kv',
  'kv.namespace.list': 'kv',
  'r2.bucket.create': 'r2',
  'r2.bucket.delete': 'r2',
  'r2.bucket.list': 'r2',
};

// Only writable fields documented by the multipart Worker settings endpoint belong here.
export const WORKER_SETTINGS_PRESERVED_FIELDS = [
  'annotations',
  'cache_options',
  'compatibility_date',
  'compatibility_flags',
  'limits',
  'logpush',
  'migrations',
  'observability',
  'placement',
  'tags',
  'tail_consumers',
  'usage_model',
] as const;

const REDACTED_VALUE = '<redacted>';
const MAX_WORKER_SETTINGS_BYTES = 1024 * 1024;
const SENSITIVE_KEY_PATTERN =
  /(^|_)(authorization|credential|private_key|secret|token|api_key)(_|$)/i;

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label}_required`);
  }
  return normalized;
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function comparableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => comparableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${comparableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isSensitiveEvidenceKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function findChangedBindingField(
  expected: CloudflareWorkerBinding,
  actual: CloudflareWorkerBinding
): string | null {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (comparableJson(expectedValue) !== comparableJson(actual[field])) {
      return field;
    }
  }
  return null;
}

function sanitizeAnnotations(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const annotations = { ...(value as Record<string, unknown>) };
  delete annotations['workers/triggered_by'];
  return annotations;
}

function assertBindings(value: unknown): CloudflareWorkerBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('worker_settings_bindings_must_be_array');
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`worker_settings_binding_${index}_must_be_object`);
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) {
      throw new Error(`worker_settings_binding_${index}_name_required`);
    }
    if (typeof record.type !== 'string' || !record.type.trim()) {
      throw new Error(`worker_settings_binding_${index}_type_required`);
    }
    const name = record.name.trim();
    if (seen.has(name)) {
      throw new Error(`worker_settings_binding_duplicate:${name}`);
    }
    seen.add(name);
    return { ...record, name, type: record.type.trim() } as CloudflareWorkerBinding;
  });
}

export function tokenKindForCloudflareOperation(
  operation: CloudflareControlOperation
): CloudflareControlTokenKind {
  return TOKEN_KIND_BY_OPERATION[operation];
}

export function selectCloudflareControlToken(
  operation: CloudflareControlOperation,
  tokens: CloudflareControlTokens
): string {
  const kind = tokenKindForCloudflareOperation(operation);
  const token = tokens[kind]?.trim();
  if (!token) {
    throw new Error(`cloudflare_${kind}_token_required_for:${operation}`);
  }
  return token;
}

export function buildVersionPinnedInheritBindings(input: {
  currentBindings: unknown;
  sourceVersionId: string;
  replaceNames?: Iterable<string>;
}): CloudflareWorkerInheritBinding[] {
  const sourceVersionId = assertNonEmpty(input.sourceVersionId, 'source_version_id');
  if (sourceVersionId === 'latest') {
    throw new Error('source_version_id_must_be_immutable');
  }
  const replaced = new Set(input.replaceNames ?? []);
  return assertBindings(input.currentBindings)
    .filter((binding) => !replaced.has(binding.name))
    .map((binding) => ({
      name: binding.name,
      type: 'inherit',
      version_id: sourceVersionId,
    }));
}

export function buildPreservingWorkerSettingsPatch(input: {
  currentSettings: CloudflareWorkerSettings;
  sourceVersionId: string;
  desiredBindings: CloudflareWorkerBinding[];
}): CloudflareWorkerSettings {
  const desiredBindings = assertBindings(input.desiredBindings);
  const desiredNames = new Set(desiredBindings.map((binding) => binding.name));
  const inheritedBindings = buildVersionPinnedInheritBindings({
    currentBindings: input.currentSettings.bindings,
    sourceVersionId: input.sourceVersionId,
    replaceNames: desiredNames,
  });
  const settings: CloudflareWorkerSettings = {
    bindings: [...inheritedBindings, ...desiredBindings.map((binding) => cloneJsonValue(binding))],
  };

  for (const field of WORKER_SETTINGS_PRESERVED_FIELDS) {
    const value = input.currentSettings[field];
    if (value === undefined) continue;
    settings[field] = cloneJsonValue(field === 'annotations' ? sanitizeAnnotations(value) : value);
  }
  return settings;
}

export function createWorkerSettingsFormData(settings: CloudflareWorkerSettings): FormData {
  const serialized = JSON.stringify(settings);
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > MAX_WORKER_SETTINGS_BYTES) {
    throw new Error(`worker_settings_payload_too_large:${size}:${MAX_WORKER_SETTINGS_BYTES}`);
  }
  const form = new FormData();
  form.set('settings', serialized);
  return form;
}

export function verifyWorkerSettingsPreserved(input: {
  before: CloudflareWorkerSettings;
  after: CloudflareWorkerSettings;
  desiredBindings: CloudflareWorkerBinding[];
}): WorkerSettingsPreservationIssue[] {
  const issues: WorkerSettingsPreservationIssue[] = [];
  const beforeBindings = assertBindings(input.before.bindings);
  const afterBindings = assertBindings(input.after.bindings);
  const desiredBindings = assertBindings(input.desiredBindings);
  const afterByName = new Map(afterBindings.map((binding) => [binding.name, binding]));
  const expectedByName = new Map(beforeBindings.map((binding) => [binding.name, binding]));
  for (const desired of desiredBindings) {
    expectedByName.set(desired.name, desired);
  }

  for (const [name, expected] of expectedByName) {
    const actual = afterByName.get(name);
    if (!actual) {
      issues.push({ field: `bindings.${name}`, reason: 'missing' });
      continue;
    }
    const changedField = findChangedBindingField(expected, actual);
    if (changedField) {
      issues.push({ field: `bindings.${name}.${changedField}`, reason: 'changed' });
    }
  }
  for (const actual of afterBindings) {
    if (!expectedByName.has(actual.name)) {
      issues.push({ field: `bindings.${actual.name}`, reason: 'unexpected' });
    }
  }

  for (const field of WORKER_SETTINGS_PRESERVED_FIELDS) {
    const expected =
      field === 'annotations' ? sanitizeAnnotations(input.before[field]) : input.before[field];
    if (expected === undefined) continue;
    if (input.after[field] === undefined) {
      issues.push({ field, reason: 'missing' });
      continue;
    }
    const actual =
      field === 'annotations' ? sanitizeAnnotations(input.after[field]) : input.after[field];
    if (comparableJson(expected) !== comparableJson(actual)) {
      issues.push({ field, reason: 'changed' });
    }
  }
  return issues;
}

export function redactControlPlaneEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactControlPlaneEvidence(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      isSensitiveEvidenceKey(key) ? REDACTED_VALUE : redactControlPlaneEvidence(entryValue),
    ])
  );
}
