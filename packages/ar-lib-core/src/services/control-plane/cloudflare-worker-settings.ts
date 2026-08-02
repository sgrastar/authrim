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
  | 'workers.script.list'
  | 'workers.subdomain.get'
  | 'workers.script.subdomain.get'
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
  'workers.script.list': 'workers',
  'workers.subdomain.get': 'workers',
  'workers.script.subdomain.get': 'workers',
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

function canonicalWorkerSettingsValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalWorkerSettingsValue(entry));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => !(parentKey === 'annotations' && key === 'workers/triggered_by'))
      .sort()
      .map((key) => [key, canonicalWorkerSettingsValue(record[key], key)])
  );
}

/**
 * Produces a secret-free, stable fingerprint of the complete settings response used by the
 * bootstrap handoff. Only the digest is persisted; settings and secret binding bodies are not.
 */
export async function digestCloudflareWorkerSettings(
  settings: CloudflareWorkerSettings
): Promise<string> {
  const canonical = JSON.stringify(canonicalWorkerSettingsValue(settings));
  if (new TextEncoder().encode(canonical).byteLength > MAX_WORKER_SETTINGS_BYTES) {
    throw new Error('worker_settings_payload_too_large');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

function writablePreservedSetting(field: string, value: unknown): unknown {
  const sanitized = field === 'annotations' ? sanitizeAnnotations(value) : value;
  if (
    sanitized &&
    typeof sanitized === 'object' &&
    !Array.isArray(sanitized) &&
    Object.keys(sanitized as Record<string, unknown>).length === 0
  ) {
    return undefined;
  }
  return sanitized;
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
    const type = record.type.trim();
    if (
      type === 'd1' &&
      !(
        (typeof record.database_id === 'string' && record.database_id.trim()) ||
        (typeof record.id === 'string' && record.id.trim())
      )
    ) {
      throw new Error(`worker_settings_binding_${index}_d1_database_id_required`);
    }
    if (
      type === 'inherit' &&
      (typeof record.version_id !== 'string' || !record.version_id.trim())
    ) {
      throw new Error(`worker_settings_binding_${index}_inherit_version_id_required`);
    }
    return { ...record, name, type } as CloudflareWorkerBinding;
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

export function buildLatestWorkerSettingsInheritBindings(input: {
  currentBindings: unknown;
  expectedSourceVersionId: string;
  replaceNames?: Iterable<string>;
}): CloudflareWorkerInheritBinding[] {
  const expectedSourceVersionId = assertNonEmpty(
    input.expectedSourceVersionId,
    'expected_source_version_id'
  );
  if (expectedSourceVersionId === 'latest') {
    throw new Error('expected_source_version_id_must_be_immutable');
  }
  const replaced = new Set(input.replaceNames ?? []);
  return assertBindings(input.currentBindings)
    .filter((binding) => !replaced.has(binding.name))
    .map((binding) => ({
      name: binding.name,
      type: 'inherit',
      // Cloudflare rejected immutable version IDs for settings inheritance in the live provider
      // matrix. The caller fences the immutable expected source before this PATCH and verifies the
      // resulting deployment and reflected settings afterward.
      version_id: 'latest',
    }));
}

export function buildPreservingWorkerSettingsPatch(input: {
  currentSettings: CloudflareWorkerSettings;
  sourceVersionId: string;
  desiredBindings: CloudflareWorkerBinding[];
}): CloudflareWorkerSettings {
  const desiredBindings = assertBindings(input.desiredBindings);
  const desiredNames = new Set(desiredBindings.map((binding) => binding.name));
  const inheritedBindings = buildLatestWorkerSettingsInheritBindings({
    currentBindings: input.currentSettings.bindings,
    expectedSourceVersionId: input.sourceVersionId,
    replaceNames: desiredNames,
  });
  const settings: CloudflareWorkerSettings = {
    bindings: [...inheritedBindings, ...desiredBindings.map((binding) => cloneJsonValue(binding))],
  };

  for (const field of WORKER_SETTINGS_PRESERVED_FIELDS) {
    const value = input.currentSettings[field];
    if (value === undefined) continue;
    const writable = writablePreservedSetting(field, value);
    if (writable !== undefined) settings[field] = cloneJsonValue(writable);
  }
  return settings;
}

export function buildRemovingWorkerBindingSettingsPatch(input: {
  currentSettings: CloudflareWorkerSettings;
  sourceVersionId: string;
  bindingName: string;
}): CloudflareWorkerSettings {
  return buildRemovingWorkerBindingsSettingsPatch({
    currentSettings: input.currentSettings,
    sourceVersionId: input.sourceVersionId,
    bindingNames: [input.bindingName],
  });
}

export function buildRemovingWorkerBindingsSettingsPatch(input: {
  currentSettings: CloudflareWorkerSettings;
  sourceVersionId: string;
  bindingNames: readonly string[];
}): CloudflareWorkerSettings {
  const currentBindings = assertBindings(input.currentSettings.bindings);
  const names = new Set(input.bindingNames);
  if (names.size === 0 || names.size !== input.bindingNames.length) {
    throw new Error('worker_settings_bindings_to_remove_invalid');
  }
  for (const name of names) {
    const matching = currentBindings.filter((binding) => binding.name === name);
    if (matching.length !== 1) {
      throw new Error(
        matching.length === 0
          ? 'worker_settings_binding_to_remove_missing'
          : 'worker_settings_binding_to_remove_ambiguous'
      );
    }
  }
  const inheritedBindings = buildLatestWorkerSettingsInheritBindings({
    currentBindings,
    expectedSourceVersionId: input.sourceVersionId,
    replaceNames: names,
  });
  const settings: CloudflareWorkerSettings = { bindings: inheritedBindings };
  for (const field of WORKER_SETTINGS_PRESERVED_FIELDS) {
    const value = input.currentSettings[field];
    if (value === undefined) continue;
    const writable = writablePreservedSetting(field, value);
    if (writable !== undefined) settings[field] = cloneJsonValue(writable);
  }
  return settings;
}

export function verifyWorkerSettingsBindingRemoved(input: {
  before: CloudflareWorkerSettings;
  after: CloudflareWorkerSettings;
  bindingName: string;
}): WorkerSettingsPreservationIssue[] {
  return verifyWorkerSettingsBindingsRemoved({
    before: input.before,
    after: input.after,
    bindingNames: [input.bindingName],
  });
}

export function verifyWorkerSettingsBindingsRemoved(input: {
  before: CloudflareWorkerSettings;
  after: CloudflareWorkerSettings;
  bindingNames: readonly string[];
}): WorkerSettingsPreservationIssue[] {
  const beforeBindings = assertBindings(input.before.bindings);
  const names = new Set(input.bindingNames);
  if (names.size === 0 || names.size !== input.bindingNames.length) {
    throw new Error('worker_settings_bindings_to_remove_invalid');
  }
  for (const name of names) {
    const matching = beforeBindings.filter((binding) => binding.name === name);
    if (matching.length !== 1) {
      throw new Error(
        matching.length === 0
          ? 'worker_settings_binding_to_remove_missing'
          : 'worker_settings_binding_to_remove_ambiguous'
      );
    }
  }
  const afterBindings = assertBindings(input.after.bindings);
  const withoutRemoved: CloudflareWorkerSettings = {
    ...input.before,
    bindings: beforeBindings.filter((binding) => !names.has(binding.name)),
  };
  const issues = verifyWorkerSettingsPreserved({
    before: withoutRemoved,
    after: input.after,
    desiredBindings: [],
  });
  for (const name of names) {
    if (afterBindings.some((binding) => binding.name === name)) {
      issues.push({ field: `bindings.${name}`, reason: 'unexpected' });
    }
  }
  return issues;
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

export function verifyWorkerSettingsRestoreIntent(input: {
  restoreSettings: CloudflareWorkerSettings;
  after: CloudflareWorkerSettings;
  desiredBindings: CloudflareWorkerBinding[];
}): WorkerSettingsPreservationIssue[] {
  const issues: WorkerSettingsPreservationIssue[] = [];
  const restoreBindings = assertBindings(input.restoreSettings.bindings);
  const desiredBindings = assertBindings(input.desiredBindings);
  const afterBindings = assertBindings(input.after.bindings);
  const expectedNames = new Set<string>();
  for (const binding of restoreBindings) {
    if (binding.type !== 'inherit') {
      throw new Error(`worker_settings_restore_binding_must_inherit:${binding.name}`);
    }
    expectedNames.add(binding.name);
  }
  const desiredByName = new Map(desiredBindings.map((binding) => [binding.name, binding]));
  for (const name of desiredByName.keys()) expectedNames.add(name);
  const afterByName = new Map(afterBindings.map((binding) => [binding.name, binding]));
  for (const name of expectedNames) {
    const actual = afterByName.get(name);
    if (!actual) {
      issues.push({ field: `bindings.${name}`, reason: 'missing' });
      continue;
    }
    const desired = desiredByName.get(name);
    if (desired) {
      const changedField = findChangedBindingField(desired, actual);
      if (changedField) {
        issues.push({ field: `bindings.${name}.${changedField}`, reason: 'changed' });
      }
    }
  }
  for (const actual of afterBindings) {
    if (!expectedNames.has(actual.name)) {
      issues.push({ field: `bindings.${actual.name}`, reason: 'unexpected' });
    }
  }
  for (const field of WORKER_SETTINGS_PRESERVED_FIELDS) {
    const expected =
      field === 'annotations'
        ? sanitizeAnnotations(input.restoreSettings[field])
        : input.restoreSettings[field];
    if (expected === undefined) continue;
    const actual =
      field === 'annotations' ? sanitizeAnnotations(input.after[field]) : input.after[field];
    if (actual === undefined) {
      issues.push({ field, reason: 'missing' });
      continue;
    }
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
