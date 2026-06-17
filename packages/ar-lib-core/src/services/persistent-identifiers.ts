export type PersistentIdentifierAlgorithm = 'authrim_sha256_base64url' | 'shibboleth_sha1_base64';

export type PersistentIdentifierAudienceMode =
  | 'runtime'
  | 'saml_sp_entity_id'
  | 'oidc_sector_identifier';

export interface PersistentIdentifierGenerationInput {
  algorithm: PersistentIdentifierAlgorithm;
  subject: string;
  audience: string;
  secret: string;
}

export async function generatePersistentIdentifier(
  input: PersistentIdentifierGenerationInput
): Promise<string> {
  if (input.algorithm === 'shibboleth_sha1_base64') {
    return digestBase64('SHA-1', `${input.audience}!${input.subject}!${input.secret}`);
  }
  return digestBase64Url('SHA-256', `${input.audience}${input.subject}${input.secret}`);
}

export function buildSAMLPairwiseSectorIdentifier(tenantId: string, spEntityId: string): string {
  return JSON.stringify(['saml', tenantId, spEntityId]);
}

export function resolveSAMLPersistentIdentifierAudience(input: {
  tenantId: string;
  spEntityId: string;
  algorithm: PersistentIdentifierAlgorithm;
  audienceMode?: PersistentIdentifierAudienceMode;
}): string {
  if (input.algorithm === 'shibboleth_sha1_base64' || input.audienceMode === 'saml_sp_entity_id') {
    return input.spEntityId;
  }
  return buildSAMLPairwiseSectorIdentifier(input.tenantId, input.spEntityId);
}

export function resolveOIDCPairwiseAudience(input: {
  clientId: string;
  sectorIdentifier?: string | null;
  audienceMode?: PersistentIdentifierAudienceMode;
}): string {
  if (input.audienceMode === 'oidc_sector_identifier' && input.sectorIdentifier) {
    return input.sectorIdentifier;
  }
  return input.clientId;
}

async function digestBase64(algorithm: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(digest));
  return btoa(String.fromCharCode(...bytes));
}

async function digestBase64Url(algorithm: string, value: string): Promise<string> {
  return (await digestBase64(algorithm, value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}
