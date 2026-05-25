import type { AuthrimDRBundle } from '../types/dr-bundle';

export interface DRBundlePrivateMaterialFinding {
  path: string;
  reason: 'forbidden_key' | 'private_key_pem';
}

const FORBIDDEN_PRIVATE_MATERIAL_KEYS = new Set([
  'privateKey',
  'private_key',
  'privateKeyPem',
  'private_key_pem',
  'privatePEM',
  'clientSecret',
  'client_secret',
  'clientSecretHash',
  'client_secret_hash',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'authorizationCode',
  'authorization_code',
  'deviceCode',
  'device_code',
]);

const PRIVATE_KEY_PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function findDRBundlePrivateMaterial(
  bundle: AuthrimDRBundle
): DRBundlePrivateMaterialFinding[] {
  const findings: DRBundlePrivateMaterialFinding[] = [];
  visitDRBundleValue(bundle, '$', findings);
  return findings;
}

export function assertDRBundleContainsNoPrivateMaterial(bundle: AuthrimDRBundle): void {
  const findings = findDRBundlePrivateMaterial(bundle);
  if (findings.length > 0) {
    throw new Error(
      `DR bundle contains private material: ${findings.map((finding) => finding.path).join(', ')}`
    );
  }
}

function visitDRBundleValue(
  value: unknown,
  path: string,
  findings: DRBundlePrivateMaterialFinding[]
): void {
  if (typeof value === 'string') {
    if (PRIVATE_KEY_PEM_PATTERN.test(value)) {
      findings.push({ path, reason: 'private_key_pem' });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => visitDRBundleValue(item, `${path}[${index}]`, findings));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_PRIVATE_MATERIAL_KEYS.has(key)) {
      findings.push({ path: childPath, reason: 'forbidden_key' });
    }
    visitDRBundleValue(child, childPath, findings);
  }
}
