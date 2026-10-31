/**
 * A tenant's ID token signing policy: the algorithm it signs ID tokens with
 * (`oauth.id_token_signing_alg`) and whether an app may choose another with its
 * id_token_signed_response_alg (`oauth.id_token_signing_alg_client_override`).
 *
 * Read strictly: when the settings cannot be read this throws, so a token is not signed (nor an
 * app registered) against a policy the tenant may have changed.
 */

import {
  DEFAULT_ID_TOKEN_SIGNING_POLICY,
  isOIDCSigningAlgorithm,
  type IDTokenSigningPolicy,
} from '../utils/oidc-signing';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';

export async function resolveIDTokenSigningPolicy(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<IDTokenSigningPolicy> {
  const values = await resolveEffectiveSettings(env, 'oauth', { tenantId });
  const algorithm = values['oauth.id_token_signing_alg'];
  return {
    algorithm: isOIDCSigningAlgorithm(algorithm)
      ? algorithm
      : DEFAULT_ID_TOKEN_SIGNING_POLICY.algorithm,
    // Only an explicit false takes the choice away from apps.
    appsMayChoose: values['oauth.id_token_signing_alg_client_override'] !== false,
  };
}
