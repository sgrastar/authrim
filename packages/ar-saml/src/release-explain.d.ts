import type { DatabaseAdapter, Env, SAMLSPConfig } from '@authrim/ar-lib-core';

/** Stable package contract; internal XML and Node types do not enter management's type scope. */
export interface SAMLFixtureExplanation {
  status: 200 | 404 | 500 | 503;
  body: Record<string, unknown>;
}

export interface SAMLFixtureExplanationRequest {
  env: Env;
  tenantId: string;
  spEntityId: string;
  user: { userId: string; attributes: Record<string, unknown> };
  consent: 'all' | 'none' | 'required';
}

export declare function explainSAMLReleaseFixture(
  request: SAMLFixtureExplanationRequest
): Promise<SAMLFixtureExplanation>;

export declare function validateSAMLSPReleaseBinding(
  env: Env,
  tenantId: string,
  config: SAMLSPConfig
): Promise<{ field: string } | null>;

export interface SAMLNameIdProfile {
  format: string | null;
  classification: string;
}

export declare function loadSAMLNameIdProfile(
  adapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<SAMLNameIdProfile | null>;
