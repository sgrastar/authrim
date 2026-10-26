/** Explicit composition for one restored SAML IdP tenant on Lambda/API Gateway. */

import {
  getTenantSettingsDocument,
  getUIConfig,
  humanVerificationSelectionFromSettings,
  readSettingsFlag,
  resolveSamlEnabled,
  type Env,
} from '@authrim/ar-lib-core';
import type { AuditRuntimePorts } from '@authrim/ar-lib-core/types/audit-runtime-ports';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { assertSAMLIdPProviderReadiness } from '@authrim/ar-saml/idp-readiness';
import { createAuthRuntimePorts } from './auth-runtime';
import { createAwsRuntimeDataPorts, type AwsDataTenantInventory } from './data-runtime';
import type { AwsTenantRuntime } from './http-runtime';
import {
  createSAMLRuntimePorts,
  createSAMLTransientStateKV,
  type SAMLRuntimeImportedSecret,
  type SAMLRuntimeSigningBundle,
} from './saml-runtime';
import { assertAwsRuntimeSchemaReady } from './import/aws-schema-bootstrap';
import { createSAMLPersistentNameIDRegistryKV } from './storage/postgres-persistent-nameid';
import type { PostgresQueryClient } from './storage/postgres-transient-state';
import { createAwsStateStores } from './storage/create-state-stores';
import type { AwsBoundAuthState } from './import/selected-auth-state';
import type { PersistentNameIDStore } from './storage/state-ports';
import { assertPasskeyOnlySamlFlowReady } from './ui/passkey-flow-profile';
import { assertAwsEventPolicyReady, createAwsEventRuntimePorts } from './event-runtime';
import { normalizeAwsRuntimeUiConfig, type AwsRuntimeUiConfig } from './ui/runtime-ui-config';

/** Read-only copies of the operator-verified Settings and legacy configuration KV keys. */
export interface AwsSnapshotKeyReader {
  get(key: string): Promise<string | null>;
}

export interface CreateAwsSamlTenantInput {
  tenantId: string;
  /** Must equal the original issuer/IdP origin advertised to each selected SP. */
  origin: string;
  /** A stable identifier used for runtime logging and cache separation. */
  environmentName: string;
  destinationUi?: AwsRuntimeUiConfig;
  inventory: AwsDataTenantInventory;
  /** Already provisioned SQL audit/activation store; also legacy authentication state. */
  stateDb: PostgresQueryClient;
  /** Explicit selected state backend, already restored and pinned by the caller. */
  authenticationState?: AwsBoundAuthState;
  /** The durable, local-only audit writer. External fanout is outside this profile. */
  auditPorts: AuditRuntimePorts;
  settings: AwsSnapshotKeyReader;
  configuration: AwsSnapshotKeyReader;
  signingBundle: SAMLRuntimeSigningBundle;
  pairwiseSecret: SAMLRuntimeImportedSecret;
  /** Existing, explicitly configured SAML SP entity IDs included in the restored snapshot. */
  spEntityIds: readonly string[];
  /** Compiled Admin mapping and active destination profile for every selected SP. */
  identityMappings: readonly SAMLRuntimeImportedSPRelease[];
  /** Stable copied consent salt, required even though consent UI is outside this profile. */
  consentIpSalt: string;
  /** Stable AWS-only secret for new Login Flow contracts; source interactions are discarded. */
  flowRuntimeHmacSecret: string;
  /** Verifies provenance, consistency boundary, freshness, and route/key generation of the import. */
  assertSnapshotReady(this: void): Promise<void>;
}

const FLOW_FLAGS = [
  'feature.enable_login_runtime_flow',
  'feature.login_runtime_flow.enabled',
  'feature.flow_runtime.enabled',
];

function validTenant(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseSettingsDocument(raw: string | null): Record<string, unknown> {
  if (raw === null) throw new Error('aws_passkey_settings_missing');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('aws_passkey_settings_invalid');
  }
  return parsed as Record<string, unknown>;
}

function enabled(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('aws_passkey_settings_invalid');
}

function assertPasskeyOnlyAuthenticationMethods(methods: Record<string, unknown>): void {
  const emailOtpEnabled = enabled(methods, 'authentication-methods.email_otp.enabled', true);
  const totpEnabled = enabled(methods, 'authentication-methods.totp.enabled', false);
  if (
    enabled(methods, 'authentication-methods.email_otp.login_enabled', emailOtpEnabled) ||
    enabled(methods, 'authentication-methods.email_otp.reauth_enabled', emailOtpEnabled) ||
    enabled(methods, 'authentication-methods.totp.login_enabled', totpEnabled) ||
    enabled(methods, 'authentication-methods.totp.reauth_enabled', totpEnabled) ||
    enabled(methods, 'authentication-methods.directory_password.enabled', false) ||
    enabled(methods, 'authentication-methods.guest.login_enabled', false)
  ) {
    throw new Error('aws_login_methods_unsupported');
  }

  // The Flow runtime consults the provider bridge when this setting is absent. An explicit
  // empty list prevents a restored provider from silently expanding the available handles.
  const rawProviders = methods['authentication-methods.external_provider_usage'];
  let providers: unknown = rawProviders;
  if (typeof rawProviders === 'string') {
    try {
      providers = JSON.parse(rawProviders);
    } catch {
      throw new Error('aws_login_methods_unsupported');
    }
  }
  if (!Array.isArray(providers) || providers.length !== 0) {
    throw new Error('aws_login_methods_unsupported');
  }
}

async function assertRuntimeSettingsReady(
  input: CreateAwsSamlTenantInput,
  env: Env,
  uiConfig: AwsRuntimeUiConfig
): Promise<void> {
  if (!(await resolveSamlEnabled(env, input.tenantId, { fresh: true }))) {
    throw new Error('aws_saml_tenant_disabled');
  }
  if (uiConfig.ui.login.mode === 'disabled') {
    if (await getUIConfig(env, input.tenantId, { strict: true })) {
      throw new Error('aws_login_ui_profile_unsupported');
    }
    return;
  }
  const raw = await input.settings.get(`settings:tenant:${input.tenantId}:authentication-methods`);
  const methods = parseSettingsDocument(raw);
  const passkeyEnabled = enabled(methods, 'authentication-methods.passkey.enabled', true);
  if (
    !enabled(methods, 'authentication-methods.passkey.login_enabled', passkeyEnabled) ||
    !enabled(methods, 'authentication-methods.passkey.reauth_enabled', passkeyEnabled)
  ) {
    throw new Error('aws_passkey_method_disabled');
  }
  assertPasskeyOnlyAuthenticationMethods(methods);
  const humanVerification = humanVerificationSelectionFromSettings(methods);
  if (humanVerification.required.login || humanVerification.required.reauth) {
    throw new Error('aws_human_verification_unsupported');
  }
  const featureSettings = await getTenantSettingsDocument(env, input.tenantId, 'feature-flags');
  if (FLOW_FLAGS.some((key) => readSettingsFlag(featureSettings, key) === false)) {
    throw new Error('aws_login_flow_feature_disabled');
  }
  const legacyFlag = await input.configuration.get('flag:ENABLE_LOGIN_RUNTIME_FLOW');
  if (legacyFlag !== null && legacyFlag !== 'true') {
    throw new Error('aws_login_flow_feature_disabled');
  }
  const ui = await getUIConfig(env, input.tenantId, { strict: true });
  const login = uiConfig.ui.login;
  if (
    ui?.baseUrl !== (login.mode === 'external' ? login.baseUrl : input.origin) ||
    ui.paths.login !== (login.mode === 'external' ? login.paths.login : '/login') ||
    ui.paths.reauth !== (login.mode === 'external' ? login.paths.reauth : '/reauth')
  ) {
    throw new Error('aws_login_ui_profile_unsupported');
  }
}

/** Only destination UI fields override captured settings; authentication policy remains intact. */
function destinationSettings(
  source: AwsSnapshotKeyReader,
  tenantId: string,
  config: AwsRuntimeUiConfig
): AwsSnapshotKeyReader {
  return {
    async get(key) {
      const raw = await source.get(key);
      if (key !== 'settings:platform:tenant' && key !== `settings:tenant:${tenantId}:tenant`)
        return raw;
      const document = raw === null ? {} : parseSettingsDocument(raw);
      delete document['tenant.ui_base_url'];
      delete document['tenant.ui_login_path'];
      delete document['tenant.ui_reauth_path'];
      if (key === `settings:tenant:${tenantId}:tenant` && config.ui.login.mode === 'external') {
        document['tenant.ui_base_url'] = config.ui.login.baseUrl;
        document['tenant.ui_login_path'] = config.ui.login.paths.login;
        document['tenant.ui_reauth_path'] = config.ui.login.paths.reauth;
      }
      return JSON.stringify(document);
    },
  };
}

/**
 * Only two persistent KV families are supported by this profile. A new caller must add an
 * explicit durable adapter instead of accidentally sharing SAML NameID state with other keys.
 */
function createPersistentRuntimeKV(
  input: CreateAwsSamlTenantInput,
  registry: PersistentNameIDStore
) {
  const nameIds = createSAMLPersistentNameIDRegistryKV(registry);
  const consentSaltKey = `consent:ip_salt:${input.tenantId}`;
  return {
    get(key: string) {
      return key === consentSaltKey ? Promise.resolve(input.consentIpSalt) : nameIds.get(key);
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      if (key === consentSaltKey) throw new Error('aws_consent_salt_immutable');
      return nameIds.put(key, value, options);
    },
  };
}

/**
 * The only Env conversion is here. It contains real PostgreSQL ports and verified key readers,
 * and deliberately contains no fabricated D1, Durable Object, queue, or service bindings.
 */
export function createAwsSamlTenant(input: CreateAwsSamlTenantInput): AwsTenantRuntime {
  const uiConfig = normalizeAwsRuntimeUiConfig(input.destinationUi);
  if (
    !validTenant(input.tenantId) ||
    input.inventory.tenantId !== input.tenantId ||
    input.signingBundle.tenantId !== input.tenantId ||
    input.pairwiseSecret.tenantId !== input.tenantId ||
    !validOrigin(input.origin) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(input.environmentName) ||
    input.spEntityIds.length === 0 ||
    new Set(input.spEntityIds).size !== input.spEntityIds.length ||
    !input.consentIpSalt ||
    input.consentIpSalt.length < 32 ||
    input.flowRuntimeHmacSecret.length < 32 ||
    typeof input.assertSnapshotReady !== 'function' ||
    typeof input.auditPorts?.append !== 'function'
  ) {
    throw new Error('aws_saml_tenant_input_invalid');
  }

  const stores =
    input.authenticationState === undefined
      ? createAwsStateStores({ backend: 'postgresql', db: input.stateDb })
      : input.authenticationState.stores;
  const state = stores.state;
  const auth = createAuthRuntimePorts({
    state,
    accountAuthentication: stores.accountAuthentication,
    authorizationCodes: stores.authorizationCodes,
    rateLimit: stores.rateLimit,
  });
  const saml = createSAMLRuntimePorts({
    state,
    authSessions: auth.sessions,
    signingBundles: [input.signingBundle],
    secrets: [input.pairwiseSecret],
    serviceProviders: [{ tenantId: input.tenantId, entityIds: input.spEntityIds }],
    serviceProviderReleases: input.identityMappings,
  });
  const data = createAwsRuntimeDataPorts([input.inventory]);
  const login = uiConfig.ui.login;
  const loginOrigin = login.mode === 'external' ? login.baseUrl : input.origin;
  const env = {
    DEFAULT_TENANT_ID: input.tenantId,
    ISSUER_URL: input.origin,
    UI_URL: login.mode === 'disabled' ? undefined : loginOrigin,
    ALLOWED_ORIGINS: login.mode === 'external' ? `${input.origin},${loginOrigin}` : input.origin,
    LOGIN_UI_ENABLED: login.mode === 'disabled' ? 'false' : 'true',
    LOGIN_UI_EXECUTION_HOST_MODE: login.mode === 'external' ? 'dedicated' : 'issuer',
    ENABLE_LOGIN_RUNTIME_FLOW: login.mode === 'disabled' ? 'false' : 'true',
    FLOW_RUNTIME_HMAC_SECRET: input.flowRuntimeHmacSecret,
    ENVIRONMENT: 'production',
    AUTHRIM_ENVIRONMENT_NAME: input.environmentName,
    SAML_METADATA_SIGNING: 'enabled',
    RUNTIME_DATA_PORTS: data,
    AUTH_RUNTIME_PORTS: auth,
    SAML_RUNTIME_PORTS: saml,
    AUDIT_RUNTIME_PORTS: input.auditPorts,
    EVENT_RUNTIME_PORTS: createAwsEventRuntimePorts({
      tenantId: input.tenantId,
      audit: input.auditPorts,
    }),
    SETTINGS:
      input.destinationUi === undefined
        ? input.settings
        : destinationSettings(input.settings, input.tenantId, uiConfig),
    AUTHRIM_CONFIG: input.configuration,
    STATE_STORE: createSAMLTransientStateKV(state),
    KV: createPersistentRuntimeKV(input, stores.persistentNameIDs),
  } as unknown as Env;

  return {
    tenantId: input.tenantId,
    origin: input.origin,
    ui: uiConfig,
    env,
    async assertReady() {
      await input.assertSnapshotReady();
      await assertAwsRuntimeSchemaReady(input.stateDb);
      await input.authenticationState?.assertReady();
      await assertRuntimeSettingsReady(input, env, uiConfig);
      if (login.mode === 'external') {
        await assertPasskeyOnlySamlFlowReady(
          input.inventory.metadataCoreDb,
          input.tenantId,
          input.spEntityIds,
          login.baseUrl,
          login.clientId
        );
      } else if (login.mode === 'embedded-rehearsal') {
        await assertPasskeyOnlySamlFlowReady(
          input.inventory.metadataCoreDb,
          input.tenantId,
          input.spEntityIds,
          input.origin
        );
      }
      await assertAwsEventPolicyReady(input.inventory.metadataCoreDb, input.tenantId);
      await assertSAMLIdPProviderReadiness({
        env,
        tenantId: input.tenantId,
        spEntityIds: input.spEntityIds,
      });
    },
  };
}
