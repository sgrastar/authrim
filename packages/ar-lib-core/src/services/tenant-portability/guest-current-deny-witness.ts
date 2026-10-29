/** Internal restore management evidence, never a user dataset or source row count. */
export const GUEST_CURRENT_DENY_WITNESS_DATASET = 'internal.guest_current_deny_authority';
export const GUEST_CURRENT_DENY_WITNESS_REASON = 'current_guest_deny_authority';
export interface GuestCurrentDenyWitness {
  version: 1;
  purpose: 'guest-current-deny-v1';
  tenantId: string;
  operationId: string;
  planDigest: string;
  sourceEnvironmentId: string;
  sourceIssuer: string;
  inventoryDigest: string;
  epochs: { family: 'core' | 'pii'; resourceId: string; revision: number }[];
  denyDigest: string;
  markerCount: number;
}
function rejected(): never {
  throw new Error('backup_guest_current_deny_witness_invalid');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rejected();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    Object.keys(result).some((key) => !keys.includes(key))
  )
    return rejected();
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value)) return rejected();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return rejected();
  return value;
}
export function guestCurrentDenyWitnessId(operationId: string, planDigest: string): string {
  return JSON.stringify(['guest-current-deny-v1', identifier(operationId), digest(planDigest)]);
}
export function parseGuestCurrentDenyWitness(
  json: string,
  expected: Pick<GuestCurrentDenyWitness, 'tenantId' | 'operationId' | 'planDigest'>
): GuestCurrentDenyWitness {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 16 * 1024)
    return rejected();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return rejected();
  }
  const input = object(value, [
    'version',
    'purpose',
    'tenantId',
    'operationId',
    'planDigest',
    'sourceEnvironmentId',
    'sourceIssuer',
    'inventoryDigest',
    'epochs',
    'denyDigest',
    'markerCount',
  ]);
  const tenantId = identifier(input.tenantId),
    operationId = identifier(input.operationId);
  const planDigest = digest(input.planDigest);
  if (
    input.version !== 1 ||
    input.purpose !== 'guest-current-deny-v1' ||
    tenantId !== expected.tenantId ||
    operationId !== expected.operationId ||
    planDigest !== expected.planDigest ||
    typeof input.sourceIssuer !== 'string' ||
    input.sourceIssuer.length > 4096 ||
    !Array.isArray(input.epochs) ||
    input.epochs.length < 2 ||
    input.epochs.length > 64 ||
    !Number.isSafeInteger(input.markerCount) ||
    Number(input.markerCount) < 0
  )
    return rejected();
  let issuer: URL;
  try {
    issuer = new URL(input.sourceIssuer);
  } catch {
    return rejected();
  }
  if (
    !['https:', 'http:'].includes(issuer.protocol) ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  )
    return rejected();
  const epochs = input.epochs.map((value) => {
    const entry = object(value, ['family', 'resourceId', 'revision']);
    if (
      !['core', 'pii'].includes(String(entry.family)) ||
      !Number.isSafeInteger(entry.revision) ||
      Number(entry.revision) < 0
    )
      return rejected();
    const family: 'core' | 'pii' = entry.family === 'core' ? 'core' : 'pii';
    return { family, resourceId: identifier(entry.resourceId), revision: Number(entry.revision) };
  });
  const keys = epochs.map((entry) => `${entry.family}:${entry.resourceId}`);
  if (
    !epochs.some((entry) => entry.family === 'core') ||
    !epochs.some((entry) => entry.family === 'pii') ||
    keys.some((key, index) => index > 0 && key <= keys[index - 1])
  )
    return rejected();
  return {
    version: 1,
    purpose: 'guest-current-deny-v1',
    tenantId,
    operationId,
    planDigest,
    sourceEnvironmentId: identifier(input.sourceEnvironmentId),
    sourceIssuer: input.sourceIssuer,
    inventoryDigest: digest(input.inventoryDigest),
    epochs,
    denyDigest: digest(input.denyDigest),
    markerCount: Number(input.markerCount),
  };
}
