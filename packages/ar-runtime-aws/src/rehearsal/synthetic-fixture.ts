/** Synthetic data only: shared AUTHRIM2 fixture for local and AWS restore rehearsals. */
import { generateKeyPairSync, hash as nodeHash, randomUUID, webcrypto } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { emptyKeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { encodeCanonicalSensitiveValueRef, generateVersion } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';
import { generateSelfSignedCertificate } from '../../../ar-saml/src/common/key-utils';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { restoreEvidenceDigest, canonicalRestoreJson } from '../import/restore-evidence';
import { SNAPSHOT_ADMIN_MAPPING_TABLES } from '../import/snapshot-admin-db';
import { awsStateSupplementPayloadSha256 } from '../import/state-restore';
import type { VerifiedAwsSamlSupplement } from '../import/runtime-assembly-input';

import { normalizeAwsRuntimeUiConfig, type AwsRuntimeUiConfig } from '../ui/runtime-ui-config';

export const TENANT = 'tenant-a';
export const ORIGIN = 'https://tenant-a.example.test';
export const SP = 'https://sp.example.test/entity';
type ExternalLogin = Extract<AwsRuntimeUiConfig['ui']['login'], { mode: 'external' }>;

export type SyntheticFixtureProfile =
  | { kind: 'in-process' }
  | {
      kind: 'aws-browser';
      issuer: string;
      spEntityId: string;
      acsUrl: string;
      externalLogin?: ExternalLogin;
    };

interface ResolvedSyntheticFixtureProfile {
  kind: 'in-process' | 'aws-browser';
  issuer: string;
  spEntityId: string;
  acsUrl: string;
  environmentName: string;
  rpId: string;
  externalLogin?: ExternalLogin;
}

/** Issuer/SP stay on isolated AWS test hosts; optional external UI metadata creates synthetic source rows only. */
export function resolveSyntheticFixtureProfile(
  input: SyntheticFixtureProfile = { kind: 'in-process' }
): ResolvedSyntheticFixtureProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('aws_synthetic_fixture_profile_invalid');
  if (input.kind === 'in-process') {
    if (Object.keys(input).some((key) => key !== 'kind'))
      throw new Error('aws_synthetic_fixture_profile_invalid');
    return {
      kind: input.kind,
      issuer: ORIGIN,
      spEntityId: SP,
      acsUrl: 'https://sp.example.test/acs',
      environmentName: 'aws-synthetic-rehearsal',
      rpId: new URL(ORIGIN).hostname,
    };
  }
  try {
    const issuer = new URL(input.issuer);
    if (
      input.kind !== 'aws-browser' ||
      issuer.protocol !== 'https:' ||
      issuer.origin !== input.issuer ||
      !/^[a-z0-9]{10}\.execute-api\.ap-northeast-1\.amazonaws\.com$/u.test(issuer.hostname) ||
      issuer.username ||
      issuer.password ||
      issuer.port ||
      input.spEntityId !== `${issuer.origin}/test-sp/metadata` ||
      input.acsUrl !== `${issuer.origin}/test-sp/acs` ||
      Object.keys(input).some(
        (key) => !['kind', 'issuer', 'spEntityId', 'acsUrl', 'externalLogin'].includes(key)
      )
    )
      throw new Error('invalid_profile');
    const externalLogin =
      input.externalLogin === undefined
        ? undefined
        : normalizeAwsRuntimeUiConfig({
            components: { loginUi: false, adminUi: false },
            ui: { login: input.externalLogin, admin: { mode: 'disabled' } },
          }).ui.login;
    if (externalLogin !== undefined && externalLogin.mode !== 'external')
      throw new Error('invalid_external_login');
    return {
      kind: input.kind,
      issuer: issuer.origin,
      spEntityId: input.spEntityId,
      acsUrl: input.acsUrl,
      environmentName: 'aws-browser-rehearsal',
      rpId: externalLogin ? new URL(externalLogin.baseUrl).hostname : issuer.hostname,
      ...(externalLogin ? { externalLogin } : {}),
    };
  } catch {
    throw new Error('aws_synthetic_fixture_profile_invalid');
  }
}

const MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
const PASSPHRASE = 'synthetic-offline-test-passphrase';
const NOW = Date.now();

export async function migrate(db: Client, directory: URL): Promise<void> {
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  // A release directory holds one fresh-install baseline per minor release and the upgrade deltas
  // after it. A new database takes the newest baseline alone: older baselines and deltas describe
  // the same schema (or upgrade from it) and would fail on the objects it already created.
  const baselines = files.filter((name) => /_baseline\.sql$/u.test(name));
  const fresh = baselines.length > 0 ? [baselines[baselines.length - 1]] : files;
  for (const file of fresh) {
    await db.query('SET search_path TO public');
    await db.query(
      renderPortableMigrationSql(await readFile(new URL(file, directory), 'utf8'), 'postgres')
    );
  }
  await db.query('SET search_path TO public');
}

function cell(value: string | number | null): PortableSqliteRow[string] {
  return value === null
    ? ['null', null]
    : typeof value === 'number'
      ? ['integer', String(value)]
      : ['text', value];
}

function row(fields: Record<string, string | number | null>): PortableSqliteRow {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cell(value)]));
}

export function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

export function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (part: Uint8Array) => {
    const bytes = Array.from(part);
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
    if (bytes[0] & 0x80) bytes.unshift(0);
    return [2, bytes.length, ...bytes];
  };
  const content = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, content.length, ...content]);
}

/** Sign only a test credential created by this module; never included in the serving artifact. */
export async function signSyntheticPasskeyAssertion(input: {
  id: string;
  privateJwk: JsonWebKey;
  rpId: string;
  origin: string;
  challenge: string;
  userId: string;
  counter: number;
}) {
  const { challenge, userId, counter, origin: browserOrigin } = input;
  const privateKey = await webcrypto.subtle.importKey(
    'jwk',
    input.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  if (!Number.isSafeInteger(counter) || counter < 1 || counter > 0xffffffff)
    throw new Error('test_passkey_counter_invalid');
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: browserOrigin,
      crossOrigin: false,
    })
  );
  const rpHash = new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(input.rpId))
  );
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter);
  const authData = new Uint8Array([...rpHash, 5, ...counterBytes]);
  const clientHash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', clientData));
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new Uint8Array([...authData, ...clientHash])
    )
  );
  return {
    id: input.id,
    rawId: input.id,
    type: 'public-key' as const,
    response: {
      clientDataJSON: base64url(clientData),
      authenticatorData: base64url(authData),
      signature: base64url(derSignature(signature)),
      userHandle: base64url(new TextEncoder().encode(userId)),
    },
    clientExtensionResults: {},
  };
}

export async function softwarePasskey(profileInput?: SyntheticFixtureProfile) {
  const profile = resolveSyntheticFixtureProfile(profileInput);
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('passkey_coordinates_missing');
  const id = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const publicKey = new Uint8Array([
    0xa5,
    1,
    2,
    3,
    0x26,
    0x20,
    1,
    0x21,
    0x58,
    32,
    ...fromBase64url(jwk.x),
    0x22,
    0x58,
    32,
    ...fromBase64url(jwk.y),
  ]);
  return {
    id,
    rpId: profile.rpId,
    publicKey,
    privateJwk: await webcrypto.subtle.exportKey('jwk', keys.privateKey),
    /** CDP WebAuthn.addCredential expects standard base64 DER PKCS#8, kept only in secret output. */
    privateKeyPkcs8Base64: btoa(
      String.fromCharCode(
        ...new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
      )
    ),
    async sign(
      challenge: string,
      userId: string,
      counter = 1,
      browserOrigin = profile.externalLogin?.baseUrl ?? profile.issuer
    ) {
      return signSyntheticPasskeyAssertion({
        id,
        privateJwk: await webcrypto.subtle.exportKey('jwk', keys.privateKey),
        rpId: profile.rpId,
        origin: browserOrigin,
        challenge,
        userId,
        counter,
      });
    },
  };
}

export async function sourceSigningBundle(profileInput?: SyntheticFixtureProfile) {
  const profile = resolveSyntheticFixtureProfile(profileInput);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJWK = publicKey.export({ format: 'jwk' });
  const certificate = await generateSelfSignedCertificate(publicJWK, privateKeyPem);
  const keyRef = `tenant:${TENANT}:saml:idp:signing`;
  const bundle = {
    kind: 'authrim.saml_local_signing_secret_dr_bundle.v1',
    version: 1,
    tenantId: TENANT,
    generatedAt: new Date(NOW).toISOString(),
    sensitive: true,
    warning: 'synthetic test',
    settings: {
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: profile.externalLogin ? 'ui_base_url' : 'tenant_host',
      certificateSubject: {
        countryName: '',
        stateOrProvinceName: '',
        localityName: '',
        organizationName: 'Authrim',
        organizationalUnitName: '',
        commonName: 'Authrim SAML Signing',
      },
      certificateSubjectAlternativeNames: { includeGeneratedDnsNames: false, dnsNames: [] },
      signingKeyPolicies: {
        idp: { active: { slot: 'active', keyRef, kid: 'key-1', certificate } },
      },
    },
    generated: {
      issuerUrl: profile.issuer,
      entityIdStyle: 'metadata_url',
      idpEntityId: `${profile.issuer}/saml/idp/metadata`,
      spEntityId: `${profile.issuer}/saml/sp/metadata`,
      idpMetadataUrl: `${profile.issuer}/saml/idp/metadata`,
      spMetadataUrl: `${profile.issuer}/saml/sp/metadata`,
    },
    keys: [
      { role: 'idp', slot: 'active', keyRef, kid: 'key-1', privateKeyPem, publicJWK, certificate },
    ],
  };
  return { bundle, certificate };
}

export async function seedSource(
  core: Client,
  pii: Client,
  credential: Awaited<ReturnType<typeof softwarePasskey>>,
  profileInput?: SyntheticFixtureProfile
) {
  const profile = resolveSyntheticFixtureProfile(profileInput);
  if (credential.rpId !== profile.rpId)
    throw new Error('aws_synthetic_fixture_credential_profile_mismatch');
  const userId = 'user-tenant-a';
  const accountId = `account:${userId}`;
  const subjectId = 'subject-tenant-a';
  const spConfig = {
    entityId: profile.spEntityId,
    acsUrl: profile.acsUrl,
    acsUrls: [profile.acsUrl],
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    signResponses: true,
    signAssertions: false,
    identityMapping: {
      fieldMappingSetId: 'set-mail',
      fieldMappingVersionId: 'version-mail',
      destinationProfileId: 'profile-mail',
      destinationFieldPolicies: { [MAIL]: 'required' },
    },
  };
  await core.query(
    `INSERT INTO tenants (id,tenant_code,tenant_key,name,is_default,created_at,updated_at)
     VALUES ($1,$1,$1,$1,FALSE,$2,$2)`,
    [TENANT, NOW]
  );
  await core.query(
    `INSERT INTO identity_providers (id,tenant_id,name,provider_type,config_json,enabled,created_at,updated_at)
     VALUES ('provider-a',$1,'SP','saml_sp',$2,1,$3,$3)`,
    [TENANT, JSON.stringify(spConfig), NOW]
  );
  await core.query(
    `INSERT INTO client_trust_policies
      (id,tenant_id,name,display_name,target_type,target_id,trusted,skip_authorization_consent,is_active,created_at,updated_at)
     VALUES ('trust-a',$1,'SP','SP','saml_sp',$2,1,1,1,$3,$3)`,
    [TENANT, profile.spEntityId, NOW]
  );
  await core.query(
    `INSERT INTO oauth_clients
      (tenant_id,client_id,client_name,redirect_uris,grant_types,response_types,application_type,allowed_channels,created_at,updated_at)
     VALUES ($1,$2,'Login UI','[]','["authorization_code"]','["code"]','web','["browser"]',$3,$3)`,
    [TENANT, profile.externalLogin?.clientId ?? 'login-ui', NOW]
  );
  await core.query(
    `INSERT INTO web_origin_registry
      (id,tenant_id,client_id,origin,handoff_allowed,created_at,updated_at)
     VALUES ('origin-a',$1,$2,$3,1,$4,$4)`,
    [
      TENANT,
      profile.externalLogin?.clientId ?? 'login-ui',
      profile.externalLogin?.baseUrl ?? profile.issuer,
      NOW,
    ]
  );
  await core.query(
    `INSERT INTO identity_subjects
      (id,tenant_id,subject_type,lifecycle_state,display_label,primary_account_id,created_at,updated_at)
     VALUES ($1,$2,'person','active','User',$3,$4,$4)`,
    [subjectId, TENANT, accountId, NOW]
  );
  await core.query(
    `INSERT INTO identity_accounts
      (id,tenant_id,account_type,lifecycle_state,legacy_user_id,primary_subject_id,
       directory_publication_state,account_route_generation,registration_state,created_at,updated_at)
     VALUES ($1,$2,'user','active',$3,$4,'active',1,'registered',$5,$5)`,
    [accountId, TENANT, userId, subjectId, NOW]
  );
  await core.query(
    `INSERT INTO users_core (id,tenant_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`,
    [userId, TENANT, NOW]
  );
  await core.query(
    `INSERT INTO passkeys (id,tenant_id,user_id,credential_id,public_key,counter,created_at,rp_id)
     VALUES ('passkey-a',$1,$2,$3,$4,0,$5,$6)`,
    [TENANT, userId, credential.id, base64url(credential.publicKey), NOW, profile.rpId]
  );
  await pii.query(
    `INSERT INTO users_pii (id,tenant_id,email,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)`,
    [userId, TENANT, `${userId}@example.test`, NOW]
  );
  await pii.query(
    `INSERT INTO identity_sensitive_values
      (id,tenant_id,owner_type,owner_id,value_key,value_json,created_at,updated_at)
     VALUES ('sensitive-a',$1,'runtime_user',$2,'email',$3::jsonb,$4,$4)`,
    [TENANT, userId, JSON.stringify(`${userId}@example.test`), NOW]
  );
  await core.query(
    `INSERT INTO contact_points
      (id,tenant_id,subject_id,account_id,contact_type,value_storage_ref,is_primary,
       verification_state,lifecycle_state,created_at,updated_at)
     VALUES ('contact-a',$1,$2,$3,'email',$4,TRUE,'verified','active',$5,$5)`,
    [
      TENANT,
      subjectId,
      accountId,
      encodeCanonicalSensitiveValueRef({ tenantId: TENANT, userId, field: 'email' }),
      NOW,
    ]
  );
  const runtimeSnapshot = {
    flow_kind: 'login',
    ui: {
      steps: [
        {
          id: 'auth:step',
          source_node_id: 'auth',
          component: 'authentication_method_selector',
          render: true,
          config: { output_handles: ['passkey'] },
        },
        { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
      ],
    },
  };
  await core.query(
    `INSERT INTO flows (id,tenant_id,name,created_at,updated_at,status,published_version_id)
     VALUES ('flow-a',$1,'SAML Passkey',$2,$2,'published','version-a')`,
    [TENANT, NOW]
  );
  await core.query(
    `INSERT INTO flow_versions
      (id,tenant_id,flow_id,version_number,schema_version,runtime_snapshot_json,
       validation_result_json,published_at,created_at)
     VALUES ('version-a',$1,'flow-a',1,'1',$2,'{}',$3,$3)`,
    [TENANT, JSON.stringify(runtimeSnapshot), NOW]
  );
  await core.query(
    `INSERT INTO flow_assignments
      (id,tenant_id,target_type,target_id,flow_kind,flow_id,enabled,created_at,updated_at)
     VALUES ('assignment-a',$1,'saml_sp',$2,'login','flow-a',TRUE,$3,$3)`,
    [TENANT, profile.spEntityId, NOW]
  );
  return { userId, accountId };
}

async function portableTableRows(
  db: Client,
  spec: (typeof POSTGRES_RESTORE_TABLE_CONTRACTS)[number]
) {
  const scalar = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
      return String(value);
    throw new Error('unsupported_source_fixture_value');
  };
  const columns = spec.columns.map((name) => `"${name}"`).join(', ');
  const selected = await db.query<Record<string, unknown>>(
    `SELECT ${columns} FROM "${spec.table}" WHERE "${spec.tenantColumn}" = $1`,
    [TENANT]
  );
  return selected.rows.map(
    (record) =>
      Object.fromEntries(
        spec.columns.map((column) => {
          const value = record[column];
          if (value === null || value === undefined) return [column, ['null', null]];
          if (spec.sqliteIntegerColumns.includes(column)) {
            return [
              column,
              ['integer', typeof value === 'boolean' ? (value ? '1' : '0') : scalar(value)],
            ];
          }
          if (spec.postgresJsonbColumns.includes(column))
            return [column, ['text', JSON.stringify(value)]];
          return [column, ['text', scalar(value)]];
        })
      ) as PortableSqliteRow
  );
}

function sourceAdminRows(profile: ReturnType<typeof resolveSyntheticFixtureProfile>) {
  const rows: Record<string, PortableSqliteRow[]> = Object.fromEntries(
    [...SNAPSHOT_ADMIN_MAPPING_TABLES, 'tenant_settings_documents'].map((table) => [table, []])
  );
  const put = (table: string, values: Record<string, string | number | null>) =>
    rows[table].push(row(values));
  const profileSchema = {
    destinationType: 'saml',
    attributes: [
      {
        name: MAIL,
        label: 'mail',
        classification: 'pii',
        nullable: false,
        valueType: 'string',
        valueMultiplicity: 'single',
      },
    ],
  };
  put('field_mapping_sets', { id: 'set-mail', tenant_id: TENANT, lifecycle_state: 'active' });
  put('field_mapping_versions', {
    id: 'version-mail',
    tenant_id: TENANT,
    field_mapping_set_id: 'set-mail',
    version_label: 'v1',
    field_mapping_hash: 'hash-mail',
    compatibility_range: '*',
  });
  put('field_mapping_activations', {
    id: 'activation-mail',
    tenant_id: TENANT,
    field_mapping_set_id: 'set-mail',
    field_mapping_version_id: 'version-mail',
    lifecycle_state: 'active',
    activation_scope_json: JSON.stringify({
      tenantId: TENANT,
      protocol: 'saml',
      role: 'idp',
      localEntityId: `${profile.issuer}/saml/idp/metadata`,
      partnerEntityId: profile.spEntityId,
      destinationProfileId: 'profile-mail',
    }),
    activated_at: NOW,
    created_at: NOW,
  });
  put('compiled_mapping_snapshots', {
    id: 'snapshot-mail',
    tenant_id: TENANT,
    field_mapping_version_id: 'version-mail',
    catalog_version_id: 'catalog-version-mail',
    snapshot_hash: 'snapshot-hash-mail',
    lifecycle_state: 'active',
  });
  put('field_catalogs', { id: 'catalog-mail', tenant_id: TENANT, lifecycle_state: 'active' });
  put('field_catalog_versions', {
    id: 'catalog-version-mail',
    tenant_id: TENANT,
    catalog_id: 'catalog-mail',
    version_label: 'v1',
    bundle_hash: 'bundle-mail',
    compatibility_range: '*',
    lifecycle_state: 'active',
    created_at: NOW,
  });
  put('field_catalog_entries', {
    id: 'source-mail',
    tenant_id: TENANT,
    catalog_version_id: 'catalog-version-mail',
    stable_field_id: 'source.email',
    namespace: 'authrim.profile',
    path: 'email',
    target_taxonomy: 'canonical',
    value_type: 'string',
    cardinality: 'single',
    classification: 'pii',
    aliases_json: '[]',
    validation_json: '{}',
  });
  put('field_catalog_entries', {
    id: 'destination-mail',
    tenant_id: TENANT,
    catalog_version_id: 'catalog-version-mail',
    stable_field_id: 'destination.mail',
    namespace: 'saml.attribute',
    path: MAIL,
    target_taxonomy: 'destination-only',
    value_type: 'string',
    cardinality: 'single',
    classification: 'pii',
    aliases_json: '[]',
    validation_json: '{}',
  });
  put('mapping_rules', {
    id: 'rule-mail',
    tenant_id: TENANT,
    field_mapping_version_id: 'version-mail',
    action: 'allow',
    priority: 0,
    created_at: NOW,
    scope_json: '{}',
    metadata_json: '{}',
  });
  put('mapping_rule_edges', {
    id: 'edge-mail',
    tenant_id: TENANT,
    rule_id: 'rule-mail',
    display_order: 0,
    edge_kind: 'direct',
    source_ref_json: JSON.stringify({
      side: 'source',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'source.email',
    }),
    target_ref_json: JSON.stringify({
      side: 'destination',
      namespace: 'saml.attribute',
      path: MAIL,
      catalogEntryId: 'destination.mail',
      profileId: 'profile-mail',
    }),
  });
  put('destination_profiles', {
    id: 'profile-mail',
    tenant_id: TENANT,
    active_version_id: 'profile-version-mail',
    destination_type: 'saml',
    lifecycle_state: 'active',
  });
  put('destination_profile_versions', {
    id: 'profile-version-mail',
    tenant_id: TENANT,
    profile_id: 'profile-mail',
    schema_json: JSON.stringify(profileSchema),
    lifecycle_state: 'active',
  });
  const methods = {
    'authentication-methods.passkey.login_enabled': true,
    'authentication-methods.passkey.reauth_enabled': true,
    'authentication-methods.email_otp.login_enabled': false,
    'authentication-methods.email_otp.reauth_enabled': false,
    'authentication-methods.totp.login_enabled': false,
    'authentication-methods.totp.reauth_enabled': false,
    'authentication-methods.directory_password.enabled': false,
    'authentication-methods.guest.login_enabled': false,
    'authentication-methods.external_provider_usage': [],
  };
  put('tenant_settings_documents', {
    tenant_id: TENANT,
    scope_type: 'tenant',
    scope_id: TENANT,
    category: 'authentication-methods',
    document_json: JSON.stringify(methods),
    version: generateVersion(methods),
  });
  return rows;
}

function requiredTable(id: string): (typeof POSTGRES_RESTORE_TABLE_CONTRACTS)[number] {
  const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((table) => table.datasetId === id);
  if (!spec) throw new Error('source_table_contract_missing');
  return spec;
}

function sourceRoute() {
  return {
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: 'default',
    targets: [
      {
        dataRole: 'tenant_core/users' as const,
        residencyPartition: 'global',
        shardId: 'core-1',
        bindingRef: 'TEST_CORE',
        requiredBindingRouteGeneration: 1,
      },
      {
        dataRole: 'tenant_pii' as const,
        residencyPartition: 'global',
        shardId: 'pii-1',
        bindingRef: 'TEST_PII',
        requiredBindingRouteGeneration: 1,
      },
    ],
  };
}

export async function buildBackupFiles(input: {
  sourceCore: Client;
  sourcePii: Client;
  signing: Awaited<ReturnType<typeof sourceSigningBundle>>;
  credential: Awaited<ReturnType<typeof softwarePasskey>>;
  directory: string;
  passphrase?: string;
  maxSnapshotAgeMs?: number;
  /** Explicit synthetic capture used by no-UI/external-source restore tests. */
  sourceLoginUi?: VerifiedAwsSamlSupplement['sourceLoginUi'];
  sourceFlowRuntimeEnabled?: boolean;
  profile?: SyntheticFixtureProfile;
}) {
  const profile = resolveSyntheticFixtureProfile(input.profile);
  if (
    input.credential.rpId !== profile.rpId ||
    input.signing.bundle.generated.issuerUrl !== profile.issuer
  )
    throw new Error('aws_synthetic_fixture_source_profile_mismatch');
  const data = new Map<string, PortableSqliteRow[]>();
  const datasets: TenantPortableDataset[] = [];
  for (const spec of POSTGRES_RESTORE_TABLE_CONTRACTS) {
    const from = spec.family === 'core' ? input.sourceCore : input.sourcePii;
    const sourceRows = await portableTableRows(from, spec);
    data.set(
      spec.datasetId,
      spec.datasetId === 'core.oauth_clients' || spec.datasetId === 'core.web_origin_registry'
        ? []
        : sourceRows
    );
    datasets.push({
      id: spec.datasetId,
      module:
        spec.datasetId === 'core.flows' ||
        spec.datasetId === 'core.flow_versions' ||
        spec.datasetId === 'core.flow_assignments'
          ? 'flows-ui'
          : 'tenant-runtime',
      kind:
        spec.datasetId.startsWith('pii.') ||
        /identity_|users_core|passkeys|contact_points|profiles/.test(spec.datasetId)
          ? 'users'
          : 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    });
  }
  const loginClient = (
    await portableTableRows(input.sourceCore, requiredTable('core.oauth_clients'))
  )[0];
  const loginOrigins = await portableTableRows(
    input.sourceCore,
    requiredTable('core.web_origin_registry')
  );
  for (const [table, rows] of Object.entries(sourceAdminRows(profile))) {
    const id = `admin.${table}`;
    data.set(id, rows);
    datasets.push({
      id,
      module: 'mapping',
      kind: 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    });
  }
  data.set('federation.saml_local_signing_state', [
    row({
      tenant_id: TENANT,
      bundle_json: JSON.stringify(input.signing.bundle),
    }),
  ]);
  datasets.push({
    id: 'federation.saml_local_signing_state',
    module: 'federation',
    kind: 'settings',
    store: 'durable_object',
    schemaVersion: 1,
    disposition: 'include',
  });
  const keyManager = emptyKeyManagerTenantBackupSnapshot();
  keyManager.rsa.secrets[`tenant:${TENANT}:saml:pairwise-nameid`] = {
    secretRef: `tenant:${TENANT}:saml:pairwise-nameid`,
    active: {
      kid: 'pairwise-a',
      value: 'source-pairwise-salt-with-thirty-two-bytes',
      createdAt: NOW,
    },
    updatedAt: NOW,
  };
  data.set('credentials.key_manager_tenant_state', [
    row({
      tenant_id: TENANT,
      snapshot_json: JSON.stringify(keyManager),
    }),
  ]);
  datasets.push({
    id: 'credentials.key_manager_tenant_state',
    module: 'credentials',
    kind: 'settings',
    store: 'durable_object',
    schemaVersion: 1,
    disposition: 'include',
  });
  const selection = {
    settings: true,
    users: true,
    admin: true,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 as const },
  };
  const session = await createTenantBundleKeyEnvelope(input.passphrase ?? PASSPHRASE);
  const bundleId = Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId,
    source: { tenantId: TENANT, issuer: profile.issuer, productVersion: '0.4.2' },
    snapshotId: `snapshot-${randomUUID()}`,
    boundaryUnixMs: NOW,
    inventoryDigestSha256: 'a'.repeat(64),
    selection,
    datasets,
  };
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    session,
    datasets: (async function* () {
      for (const dataset of datasets) {
        yield {
          datasetId: dataset.id,
          chunks: (async function* () {
            const rows = data.get(dataset.id) ?? [];
            if (rows.length)
              yield new TextEncoder().encode(
                `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`
              );
          })(),
        };
      }
    })(),
  });
  const partPaths: string[] = [];
  for (const [index, bytes] of encoded.parts.entries()) {
    const path = join(input.directory, `backup-${index}.bin`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    partPaths.push(path);
  }
  const state = {
    receipt: {
      tenantId: TENANT,
      issuer: profile.issuer,
      productVersion: manifest.source.productVersion,
      bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: '',
    },
    accountAuthStates: [
      {
        tenantId: TENANT,
        userId: 'user-tenant-a',
        accountId: 'account:user-tenant-a',
        lifecycle: 'active' as const,
        lifecycleVersionMs: NOW,
        lifecycleOperationId: null,
        revokedAfterMs: null,
        lastLoginAtMs: null,
      },
    ],
    passkeyCounters: [
      {
        tenantId: TENANT,
        passkeyId: 'passkey-a',
        userId: 'user-tenant-a',
        credentialId: input.credential.id,
        counter: '0',
        updatedAtMs: NOW,
      },
    ],
    persistentNameIdsComplete: true as const,
    persistentNameIds: [],
  };
  state.receipt.supplementSha256 = awsStateSupplementPayloadSha256(state);
  const payload: Omit<VerifiedAwsSamlSupplement, 'receipt'> = {
    sourceLoginUi: input.sourceLoginUi ?? { client: loginClient, origins: loginOrigins },
    platformDestinationProfiles: { profiles: [], versions: [] },
    state,
    accountRoutes: { 'account:user-tenant-a': sourceRoute() },
    platformSettings: {},
    sourceFlowRuntimeEnabled: input.sourceFlowRuntimeEnabled ?? true,
    consentIpSalt: 'consent-salt-with-at-least-thirty-two-bytes',
  };
  const supplement: {
    formatVersion: 1;
    receipt: VerifiedAwsSamlSupplement['receipt'];
    payload: typeof payload;
  } = {
    formatVersion: 1,
    receipt: {
      tenantId: TENANT,
      issuer: profile.issuer,
      productVersion: manifest.source.productVersion,
      bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: restoreEvidenceDigest(payload),
    },
    payload,
  };
  const supplementBytes = canonicalRestoreJson(supplement);
  const supplementPath = join(input.directory, 'supplement.json');
  await writeFile(supplementPath, supplementBytes, { flag: 'wx', mode: 0o600 });
  return {
    manifest,
    backup: {
      partPaths,
      receipt: {
        source: manifest.source,
        bundleId,
        snapshotId: manifest.snapshotId,
        inventoryDigestSha256: manifest.inventoryDigestSha256,
        parts: encoded.parts.map((part) => ({
          size: part.length,
          sha256: nodeHash('sha256', part, 'hex'),
        })),
      },
      passphrase: input.passphrase ?? PASSPHRASE,
      selection,
      datasets,
      maxSnapshotAgeMs: input.maxSnapshotAgeMs ?? 60 * 60 * 1000,
    },
    supplement: {
      path: supplementPath,
      expectedSha256: nodeHash('sha256', supplementBytes, 'hex'),
    },
  };
}
