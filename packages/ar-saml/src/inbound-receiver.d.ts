import type { Env, SAMLAssertion, SAMLIdPConfig } from '@authrim/ar-lib-core';

/** The actual ACS receiver projection without importing its session/XML handler types. */
export declare function extractUserInfo(
  env: Env,
  tenantId: string,
  spEntityId: string,
  assertion: SAMLAssertion,
  idpConfig: SAMLIdPConfig
): Promise<{
  email?: string;
  name?: string;
  nameId: string;
  nameIdFormat: string;
  attributes: Record<string, string[]>;
  customClaims: Record<string, unknown>;
  profile: Record<string, string>;
}>;
