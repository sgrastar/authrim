import type { Env } from '@authrim/ar-lib-core';
import { OIDCRPClient } from '../clients/oidc-client';
import type { DynamicClientRegistrationConfig, UpstreamProvider } from '../types';
import { decrypt, encrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import { updateProvider } from './provider-store';

export function getDynamicClientRegistrationConfig(
  provider: UpstreamProvider
): DynamicClientRegistrationConfig | undefined {
  const value = provider.providerQuirks?.dynamicClientRegistration;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const config = value as Record<string, unknown>;
  if (config.enabled !== true) return undefined;
  return {
    enabled: true,
    registeredIssuer:
      typeof config.registeredIssuer === 'string' ? config.registeredIssuer : undefined,
    clientName: typeof config.clientName === 'string' ? config.clientName : undefined,
    initiateLoginUri:
      typeof config.initiateLoginUri === 'string' ? config.initiateLoginUri : undefined,
    requestUris: Array.isArray(config.requestUris)
      ? config.requestUris.filter((item): item is string => typeof item === 'string')
      : undefined,
    userinfoSignedResponseAlg:
      typeof config.userinfoSignedResponseAlg === 'string'
        ? config.userinfoSignedResponseAlg
        : undefined,
    initialAccessTokenEncrypted:
      typeof config.initialAccessTokenEncrypted === 'string'
        ? config.initialAccessTokenEncrypted
        : undefined,
  };
}

async function decryptRequired(env: Env, encrypted: string): Promise<string> {
  const key = getEncryptionKeyOrUndefined(env);
  if (!key) throw new Error('RP token encryption key is not configured');
  return decrypt(encrypted, key);
}

export async function ensureDynamicClientRegistration(options: {
  env: Env;
  tenantId: string;
  provider: UpstreamProvider;
  callbackUri: string;
  force?: boolean;
}): Promise<{ provider: UpstreamProvider; clientSecret: string; registered: boolean }> {
  const { env, tenantId, callbackUri, force = false } = options;
  const config = getDynamicClientRegistrationConfig(options.provider);
  const existingSecret = await decryptRequired(env, options.provider.clientSecretEncrypted);
  if (!config || (!force && config.registeredIssuer === options.provider.issuer)) {
    return { provider: options.provider, clientSecret: existingSecret, registered: false };
  }
  if (!options.provider.issuer) throw new Error('Dynamic registration requires an issuer');

  const registrationClient = OIDCRPClient.fromProvider(
    options.provider,
    callbackUri,
    existingSecret
  );
  const initialAccessToken = config.initialAccessTokenEncrypted
    ? await decryptRequired(env, config.initialAccessTokenEncrypted)
    : undefined;
  const registration = await registrationClient.registerClient({
    redirect_uris: [callbackUri],
    client_name: config.clientName || options.provider.name,
    token_endpoint_auth_method: options.provider.tokenEndpointAuthMethod || 'client_secret_basic',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    application_type: 'web',
    initiate_login_uri: config.initiateLoginUri,
    request_uris: config.requestUris,
    request_object_signing_alg: options.provider.useRequestObject
      ? options.provider.requestObjectSigningAlg
      : undefined,
    userinfo_signed_response_alg: config.userinfoSignedResponseAlg,
    jwks: options.provider.publicKeyJwk ? { keys: [options.provider.publicKeyJwk] } : undefined,
    initialAccessToken,
  });
  if (!registration.client_secret) {
    throw new Error('Dynamic registration did not return a client secret');
  }
  const encryptionKey = getEncryptionKeyOrUndefined(env);
  if (!encryptionKey) throw new Error('RP token encryption key is not configured');
  const provider = await updateProvider(env, tenantId, options.provider.id, {
    clientId: registration.client_id,
    clientSecretEncrypted: await encrypt(registration.client_secret, encryptionKey),
    tokenEndpointAuthMethod:
      registration.token_endpoint_auth_method === 'client_secret_post'
        ? 'client_secret_post'
        : 'client_secret_basic',
    providerQuirks: {
      ...options.provider.providerQuirks,
      dynamicClientRegistration: {
        ...config,
        registeredIssuer: options.provider.issuer,
      },
    },
  });
  if (!provider) throw new Error('Provider disappeared during dynamic registration');
  return {
    provider,
    clientSecret: registration.client_secret,
    registered: true,
  };
}
