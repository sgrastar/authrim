import { SAML_DR_RUNTIME_STATE_DATASET } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import {
  readEmbeddedSamlDrCapture,
  buildAwsSamlSupplementFromFrozenCapture,
} from './supplement-collector';
import { canonicalRestoreJson } from './restore-evidence';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  createLookupBlindIndex,
  generateVersion,
  passkeyCredentialLookupSubject,
  settingsStorageKey,
  validateAccountRouteProjection,
  type LookupIdentifierRow,
} from '@authrim/ar-lib-core';
import { decodeKeyManagerTenantBackupRow } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  validateSAMLLocalSigningSecretDRBundle,
  type SAMLLocalSigningSecretDRBundle,
} from '../../../ar-saml/src/admin/local-signing-dr-bundle';
import { buildSAMLEntityIdFromIssuerUrl } from '../../../ar-saml/src/common/entity-id';
import { compileSAMLImportedSPRelease } from '../../../ar-saml/src/idp/runtime-identity-mapping';
import { createAwsSamlTenant, type AwsSnapshotKeyReader } from '../bootstrap';
import type { AwsDataTenantInventory } from '../data-runtime';
import type { AwsTenantRuntime } from '../http-runtime';
import type { SAMLRuntimeImportedSecret } from '../saml-runtime';
import { buildCoreAccountRouteGenerations } from './core-route-generations';
import type { AssembleAwsSamlTenantInput } from './runtime-assembly-input';
import {
  createSnapshotAdminAdapter,
  SNAPSHOT_ADMIN_MAPPING_TABLES,
  type SnapshotAdminMappingTable,
} from './snapshot-admin-db';
import { readVerifiedRows, rowInteger, rowNullableText, rowText } from './verified-rows';

import {
  isAwsUiOrigin,
  normalizeAwsRuntimeUiConfig,
  type AwsRuntimeUiConfig,
} from '../ui/runtime-ui-config';

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CATEGORY = /^[a-zA-Z0-9_-]{1,128}$/u;
const CONSUMED_NON_DATABASE_DATASETS = new Set([
  SAML_DR_RUNTIME_STATE_DATASET.id,
  'federation.saml_local_signing_state',
  'credentials.key_manager_tenant_state',
]);
const CONSUMED_ADMIN_DATABASE_DATASETS = new Set([
  'admin.tenant_settings_documents',
  ...SNAPSHOT_ADMIN_MAPPING_TABLES.map((table) => `admin.${table}`),
]);

function invalid(): never {
  throw new Error('aws_runtime_assembly_invalid');
}

function sameManifest(input: AssembleAwsSamlTenantInput): void {
  const manifest = input.backup.manifest;
  const receipt = input.supplement.receipt;
  if (
    !manifest.selection.settings ||
    !manifest.selection.users ||
    !receipt ||
    receipt.tenantId !== manifest.source.tenantId ||
    receipt.issuer !== manifest.source.issuer ||
    receipt.productVersion !== manifest.source.productVersion ||
    receipt.bundleId !== manifest.bundleId ||
    receipt.snapshotId !== manifest.snapshotId ||
    receipt.inventoryDigestSha256 !== manifest.inventoryDigestSha256 ||
    !HEX_SHA256.test(receipt.supplementSha256) ||
    typeof input.supplement.sourceFlowRuntimeEnabled !== 'boolean' ||
    (normalizeAwsRuntimeUiConfig(input.destinationUi).ui.login.mode !== 'disabled' &&
      input.supplement.sourceFlowRuntimeEnabled !== true) ||
    input.restored.committed.core.status !== 'committed_staging' ||
    input.restored.committed.core.family !== 'core' ||
    input.restored.committed.core.tenantId !== receipt.tenantId ||
    input.restored.committed.core.bundleId !== receipt.bundleId ||
    input.restored.committed.core.snapshotId !== receipt.snapshotId ||
    input.restored.committed.core.inventoryDigestSha256 !== receipt.inventoryDigestSha256 ||
    input.restored.committed.pii.status !== 'committed_staging' ||
    input.restored.committed.pii.family !== 'pii' ||
    input.restored.committed.pii.tenantId !== receipt.tenantId ||
    input.restored.committed.pii.bundleId !== receipt.bundleId ||
    input.restored.committed.pii.snapshotId !== receipt.snapshotId ||
    input.restored.committed.pii.inventoryDigestSha256 !== receipt.inventoryDigestSha256 ||
    input.restored.committed.state.tenantId !== receipt.tenantId ||
    input.restored.committed.state.source.tenantId !== receipt.tenantId ||
    input.restored.committed.state.source.issuer !== receipt.issuer ||
    input.restored.committed.state.source.productVersion !== receipt.productVersion ||
    input.restored.committed.state.bundleId !== receipt.bundleId ||
    input.restored.committed.state.snapshotId !== receipt.snapshotId ||
    input.restored.committed.state.inventoryDigestSha256 !== receipt.inventoryDigestSha256 ||
    input.restored.committed.state.supplementSha256 !==
      input.supplement.state.receipt.supplementSha256 ||
    input.supplement.state.receipt.tenantId !== receipt.tenantId ||
    input.supplement.state.receipt.issuer !== receipt.issuer ||
    input.supplement.state.receipt.productVersion !== receipt.productVersion ||
    input.supplement.state.receipt.bundleId !== receipt.bundleId ||
    input.supplement.state.receipt.snapshotId !== receipt.snapshotId ||
    input.supplement.state.receipt.inventoryDigestSha256 !== receipt.inventoryDigestSha256 ||
    input.spEntityIds.length === 0 ||
    new Set(input.spEntityIds).size !== input.spEntityIds.length ||
    input.awsLookupReadKeys.length < 1 ||
    input.awsLookupReadKeys.length > 2 ||
    input.awsFlowRuntimeHmacSecret.length < 32 ||
    typeof input.assertSnapshotReady !== 'function'
  )
    invalid();
}

export function assertCompleteDatasetCoverage(
  input: Pick<AssembleAwsSamlTenantInput, 'backup'>
): void {
  for (const dataset of input.backup.manifest.datasets) {
    if (dataset.disposition !== 'include') {
      if (input.backup.dataset(dataset.id).rows > 0) invalid();
      continue;
    }
    if (dataset.store !== 'database') {
      if (
        !CONSUMED_NON_DATABASE_DATASETS.has(dataset.id) &&
        input.backup.dataset(dataset.id).rows > 0
      ) {
        invalid();
      }
    } else {
      const allowedFamily = dataset.id.startsWith('core.') || dataset.id.startsWith('pii.');
      if (
        !allowedFamily &&
        !CONSUMED_ADMIN_DATABASE_DATASETS.has(dataset.id) &&
        input.backup.dataset(dataset.id).rows > 0
      )
        invalid();
    }
  }
}

function parseSettingsDocument(raw: string, version: string): void {
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    return invalid();
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    generateVersion(document as Record<string, unknown>) !== version
  )
    invalid();
}

async function settingsReader(
  input: AssembleAwsSamlTenantInput,
  saml: SAMLLocalSigningSecretDRBundle
): Promise<AwsSnapshotKeyReader> {
  const tenantId = input.backup.manifest.source.tenantId;
  const values = new Map<string, string>();
  const rows = await readVerifiedRows(input.backup, 'admin.tenant_settings_documents');
  for (const row of rows) {
    if (rowText(row, 'tenant_id') !== tenantId) invalid();
    const scope = rowText(row, 'scope_type');
    const scopeId = rowText(row, 'scope_id');
    const category = rowText(row, 'category');
    const documentJson = rowText(row, 'document_json');
    const version = rowText(row, 'version');
    parseSettingsDocument(documentJson, version);
    const key =
      scope === 'tenant'
        ? settingsStorageKey(category, { type: 'tenant', id: scopeId })
        : scope === 'client'
          ? settingsStorageKey(category, { type: 'client', tenantId, id: scopeId })
          : invalid();
    if ((scope === 'tenant' && scopeId !== tenantId) || values.has(key)) invalid();
    values.set(key, documentJson);
  }
  for (const [category, { documentJson, version }] of Object.entries(
    input.supplement.platformSettings
  )) {
    if (!SAFE_CATEGORY.test(category)) invalid();
    parseSettingsDocument(documentJson, version);
    const key = settingsStorageKey(category, { type: 'platform' });
    if (values.has(key)) invalid();
    values.set(key, documentJson);
  }
  const samlKey = settingsStorageKey('saml', { type: 'tenant', id: tenantId });
  const storedSaml = values.get(samlKey);
  if (storedSaml !== undefined) {
    // The local-signing export captures the public settings actually used by the source runtime.
    // An independently stored canonical copy must agree on those policy fields.
    let canonical: Record<string, unknown>;
    try {
      canonical = JSON.parse(storedSaml) as Record<string, unknown>;
    } catch {
      return invalid();
    }
    for (const [key, value] of Object.entries(saml.settings)) {
      if (
        canonical[key] !== undefined &&
        JSON.stringify(canonical[key]) !== JSON.stringify(value)
      ) {
        invalid();
      }
    }
  }
  values.set(samlKey, JSON.stringify(saml.settings));
  return { get: async (key) => values.get(key) ?? null };
}

async function signingBundle(
  input: AssembleAwsSamlTenantInput
): Promise<SAMLLocalSigningSecretDRBundle> {
  const rows = await readVerifiedRows(input.backup, 'federation.saml_local_signing_state');
  if (rows.length !== 1) invalid();
  const tenantId = input.backup.manifest.source.tenantId;
  const row = rows[0];
  if (
    Object.keys(row).sort().join(',') !== 'bundle_json,tenant_id' ||
    rowText(row, 'tenant_id') !== tenantId
  )
    invalid();
  let bundle: SAMLLocalSigningSecretDRBundle;
  try {
    bundle = JSON.parse(rowText(row, 'bundle_json')) as SAMLLocalSigningSecretDRBundle;
    validateSAMLLocalSigningSecretDRBundle(bundle, tenantId);
  } catch {
    return invalid();
  }
  assertSourceSAMLSigningPolicy(bundle, input.backup.manifest.source.issuer, input.destinationUi);
  return bundle;
}

export function assertSourceSAMLSigningPolicy(
  bundle: Pick<SAMLLocalSigningSecretDRBundle, 'generated' | 'settings'>,
  issuer: string,
  destinationUi?: AwsRuntimeUiConfig
): void {
  const login = normalizeAwsRuntimeUiConfig(destinationUi).ui.login;
  if (
    bundle.generated.issuerUrl !== issuer ||
    (login.mode === 'external'
      ? bundle.settings.interactiveLoginUrlPolicy !== 'ui_base_url'
      : login.mode === 'embedded-rehearsal' &&
        bundle.settings.interactiveLoginUrlPolicy !== 'tenant_host') ||
    bundle.generated.idpEntityId !==
      buildSAMLEntityIdFromIssuerUrl(issuer, 'idp', bundle.settings.entityIdStyle)
  )
    invalid();
}

async function pairwiseSecret(
  input: AssembleAwsSamlTenantInput
): Promise<SAMLRuntimeImportedSecret> {
  const rows = await readVerifiedRows(input.backup, 'credentials.key_manager_tenant_state');
  if (rows.length !== 1) invalid();
  const tenantId = input.backup.manifest.source.tenantId;
  const snapshot = await decodeKeyManagerTenantBackupRow(JSON.stringify(rows[0]), tenantId);
  const secretRef = `tenant:${tenantId}:saml:pairwise-nameid`;
  const source = snapshot.rsa.secrets[secretRef];
  const fallback = input.supplement.sourcePairwiseFallbackSecret;
  if (source && fallback !== undefined) invalid();
  if (source) {
    if (source.secretRef !== secretRef) invalid();
    return { tenantId, ...source };
  }
  if (typeof fallback !== 'string' || fallback.length < 32) invalid();
  const createdAt = input.backup.manifest.boundaryUnixMs;
  return {
    tenantId,
    secretRef,
    active: { kid: 'source-pairwise-env-fallback', value: fallback, createdAt },
    updatedAt: createdAt,
  };
}

export async function verifyRestoredSourceLoginUi(
  input: AssembleAwsSamlTenantInput
): Promise<void> {
  const tenantId = input.backup.manifest.source.tenantId;
  const source = input.supplement.sourceLoginUi;
  const login = normalizeAwsRuntimeUiConfig(input.destinationUi).ui.login;
  if (source && 'mode' in source) {
    if (source.mode !== 'disabled' || Object.keys(source).length !== 1 || login.mode !== 'disabled')
      invalid();
    return;
  }
  if (!source || !Array.isArray(source.origins as unknown) || source.origins.length !== 1)
    invalid();
  const clientId = rowText(source.client, 'client_id');
  const origin = rowText(source.origins[0], 'origin');
  if (login.mode === 'external' && (clientId !== login.clientId || origin !== login.baseUrl))
    invalid();
  if (
    login.mode === 'embedded-rehearsal' &&
    (clientId !== 'login-ui' || origin !== input.backup.manifest.source.issuer)
  )
    invalid();
  if (
    !isAwsUiOrigin(origin) ||
    rowText(source.client, 'tenant_id') !== tenantId ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(clientId) ||
    rowText(source.client, 'application_type') !== 'web' ||
    rowNullableText(source.client, 'client_secret_hash') !== null ||
    rowNullableText(source.client, 'logout_webhook_secret_encrypted') !== null ||
    source.origins.length !== 1 ||
    rowText(source.origins[0], 'tenant_id') !== tenantId ||
    rowText(source.origins[0], 'client_id') !== clientId ||
    rowText(source.origins[0], 'origin') !== origin ||
    rowInteger(source.origins[0], 'handoff_allowed') !== 1 ||
    rowInteger(source.origins[0], 'is_active') !== 1
  )
    invalid();
  let channels: unknown;
  try {
    channels = JSON.parse(rowText(source.client, 'allowed_channels')) as unknown;
  } catch {
    invalid();
  }
  if (!Array.isArray(channels) || !channels.includes('browser')) invalid();
  const client = await input.restored.metadataCoreDb.queryOne<{
    tenant_id: string;
    client_id: string;
    application_type: string;
    allowed_channels: string;
    client_secret_hash: string | null;
  }>(
    'SELECT tenant_id, client_id, application_type, allowed_channels, client_secret_hash FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenantId, clientId]
  );
  const restoredOrigin = await input.restored.metadataCoreDb.queryOne<{
    tenant_id: string;
    client_id: string;
    origin: string;
    handoff_allowed: number;
    is_active: number;
  }>(
    'SELECT tenant_id, client_id, origin, handoff_allowed, is_active FROM web_origin_registry WHERE tenant_id = ? AND client_id = ? AND origin = ?',
    [tenantId, clientId, origin]
  );
  if (
    !client ||
    client.tenant_id !== tenantId ||
    client.client_id !== clientId ||
    client.application_type !== rowText(source.client, 'application_type') ||
    client.allowed_channels !== rowText(source.client, 'allowed_channels') ||
    client.client_secret_hash !== null ||
    !restoredOrigin ||
    restoredOrigin.tenant_id !== tenantId ||
    restoredOrigin.client_id !== clientId ||
    restoredOrigin.origin !== origin ||
    restoredOrigin.handoff_allowed !== 1 ||
    restoredOrigin.is_active !== 1
  )
    invalid();
}

async function importedReleases(input: AssembleAwsSamlTenantInput, idpEntityId: string) {
  const tenantId = input.backup.manifest.source.tenantId;
  const adminRows = Object.fromEntries(
    await Promise.all(
      SNAPSHOT_ADMIN_MAPPING_TABLES.map(
        async (table) => [table, await readVerifiedRows(input.backup, `admin.${table}`)] as const
      )
    )
  ) as Record<SnapshotAdminMappingTable, PortableSqliteRow[]>;
  const admin = createSnapshotAdminAdapter({
    tenantId,
    rows: adminRows,
    platformRows: {
      destination_profiles: input.supplement.platformDestinationProfiles.profiles,
      destination_profile_versions: input.supplement.platformDestinationProfiles.versions,
    },
  });
  try {
    const providers = await readVerifiedRows(input.backup, 'core.identity_providers');
    const releases = [];
    for (const entityId of input.spEntityIds) {
      const matches = providers.filter((row) => {
        if (rowText(row, 'tenant_id') !== tenantId || rowText(row, 'provider_type') !== 'saml_sp') {
          return false;
        }
        try {
          const config = JSON.parse(rowText(row, 'config_json')) as Record<string, unknown>;
          return config.entityId === entityId;
        } catch {
          invalid();
        }
      });
      if (matches.length !== 1 || rowInteger(matches[0], 'enabled') !== 1) invalid();
      const spConfig = JSON.parse(rowText(matches[0], 'config_json')) as SAMLSPConfig;
      const release = await compileSAMLImportedSPRelease({
        adminAdapter: admin,
        coreAdapter: input.restored.metadataCoreDb,
        tenantId,
        idpEntityId,
        spConfig,
      });
      const setRows = adminRows.field_mapping_sets.filter(
        (row) => rowText(row, 'id') === release.sourceBindingRef.fieldMappingSetId
      );
      if (
        setRows.length !== 1 ||
        rowText(setRows[0], 'tenant_id') !== tenantId ||
        rowText(setRows[0], 'lifecycle_state') !== 'active'
      )
        invalid();
      const catalogVersionId = (
        release.binding as {
          catalog?: { identity?: { id?: unknown } };
        }
      ).catalog?.identity?.id;
      if (typeof catalogVersionId !== 'string') invalid();
      const catalogVersionRows = adminRows.field_catalog_versions.filter(
        (row) => rowText(row, 'id') === catalogVersionId
      );
      if (catalogVersionRows.length === 1) {
        const catalogId = rowText(catalogVersionRows[0], 'catalog_id');
        const catalogRows = adminRows.field_catalogs.filter(
          (row) => rowText(row, 'id') === catalogId
        );
        if (
          catalogRows.length !== 1 ||
          rowText(catalogRows[0], 'tenant_id') !== tenantId ||
          rowText(catalogRows[0], 'lifecycle_state') !== 'active'
        )
          invalid();
      } else if (!/^system_default_canonical_catalog_schema_v\d+$/u.test(catalogVersionId))
        invalid();
      releases.push(release);
    }
    return releases;
  } finally {
    await admin.close();
  }
}

async function rebuiltLookup(
  input: AssembleAwsSamlTenantInput
): Promise<Pick<AwsDataTenantInventory, 'lookupRows' | 'coreAccountRouteGenerations'>> {
  const tenantId = input.backup.manifest.source.tenantId;
  const accounts = await readVerifiedRows(input.backup, 'core.identity_accounts');
  const generations = buildCoreAccountRouteGenerations(tenantId, accounts);
  const routes = input.supplement.accountRoutes;
  if (Object.keys(routes).length !== Object.keys(generations).length) invalid();
  const lookupRows: LookupIdentifierRow[] = [];
  const routeByAccount = new Map<string, ReturnType<typeof validateAccountRouteProjection>>();
  for (const [accountId, generation] of Object.entries(generations)) {
    const rawRoute = routes[accountId];
    if (!rawRoute) invalid();
    const route = validateAccountRouteProjection(rawRoute);
    if (route.accountRouteGeneration !== generation || route.targets.length !== 2) invalid();
    for (const role of ['tenant_core/users', 'tenant_pii'] as const) {
      const targets = route.targets.filter((target) => target.dataRole === role);
      if (targets.length !== 1) invalid();
      const map =
        role === 'tenant_core/users'
          ? input.restored.accountCoreByBindingRef
          : input.restored.accountPiiByBindingRef;
      if (!Object.hasOwn(map, targets[0].bindingRef)) invalid();
    }
    routeByAccount.set(accountId, route);
  }
  async function addIndex(
    accountId: string,
    kind: 'account_id' | 'external_subject',
    identifier: string | { issuer: string; subject: string }
  ) {
    const route = routeByAccount.get(accountId);
    if (!route) invalid();
    for (const key of input.awsLookupReadKeys) {
      const index = await createLookupBlindIndex(kind, identifier, key);
      lookupRows.push({
        virtual_bucket: index.virtualBucket,
        index_kind: index.indexKind,
        normalization_version: index.normalizationVersion,
        hmac_key_generation: index.hmacKeyGeneration,
        identifier_blind_digest: index.digest,
        tenant_id: tenantId,
        account_id: accountId,
        route_schema_version: route.schemaVersion,
        account_route_generation: route.accountRouteGeneration,
        required_binding_route_generation: Math.max(
          ...route.targets.map((target) => target.requiredBindingRouteGeneration)
        ),
        residency_policy_id: route.residencyPolicyId,
        route_projection_json: JSON.stringify(route),
        tenant_lifecycle_state: 'active',
        runtime_route_status: 'active',
        lifecycle_state: 'active',
      });
    }
  }
  for (const accountId of Object.keys(generations))
    await addIndex(accountId, 'account_id', accountId);
  const passkeys = await readVerifiedRows(input.backup, 'core.passkeys');
  const seenCredentials = new Set<string>();
  // Direct Auth derives RP ID from the validated browser Origin, never from a supplied RP override.
  // Include only credentials already enrolled for that exact host; source rows remain unchanged.
  const login = normalizeAwsRuntimeUiConfig(input.destinationUi).ui.login;
  const rpId = new URL(
    login.mode === 'external' ? login.baseUrl : input.backup.manifest.source.issuer
  ).hostname;
  for (const passkey of passkeys) {
    if (rowText(passkey, 'tenant_id') !== tenantId) invalid();
    const credentialId = rowText(passkey, 'credential_id');
    if (seenCredentials.has(credentialId)) invalid();
    seenCredentials.add(credentialId);
    const accountId = `account:${rowText(passkey, 'user_id')}`;
    if (!routeByAccount.has(accountId) || rowNullableText(passkey, 'rp_id') !== rpId) continue;
    await addIndex(
      accountId,
      'external_subject',
      passkeyCredentialLookupSubject({ rpId, credentialId })
    );
  }
  if (lookupRows.length === 0) invalid();
  return { lookupRows, coreAccountRouteGenerations: generations };
}

/** Assemble one existing, explicitly selected SAML IdP from a complete verified source backup. */
export async function assembleAwsSamlTenantFromBackup(
  input: AssembleAwsSamlTenantInput
): Promise<AwsTenantRuntime> {
  sameManifest(input);
  if (input.backup.manifest.datasets.some(({ id }) => id === SAML_DR_RUNTIME_STATE_DATASET.id)) {
    const embedded = await buildAwsSamlSupplementFromFrozenCapture({
      backup: input.backup,
      capture: await readEmbeddedSamlDrCapture(input.backup),
    });
    const { receipt, ...payload } = input.supplement;
    if (
      canonicalRestoreJson(receipt) !== canonicalRestoreJson(embedded.receipt) ||
      canonicalRestoreJson(payload) !== canonicalRestoreJson(embedded.payload)
    )
      invalid();
  }
  assertCompleteDatasetCoverage(input);
  await input.assertSnapshotReady();
  const saml = await signingBundle(input);
  const [settings, secret, lookup] = await Promise.all([
    settingsReader(input, saml),
    pairwiseSecret(input),
    rebuiltLookup(input),
  ]);
  await verifyRestoredSourceLoginUi(input);
  const mappings = await importedReleases(input, saml.generated.idpEntityId);
  const tenantId = input.backup.manifest.source.tenantId;
  return createAwsSamlTenant({
    tenantId,
    origin: input.backup.manifest.source.issuer,
    environmentName: input.environmentName,
    destinationUi: input.destinationUi,
    inventory: {
      tenantId,
      allocationScope: input.allocationScope,
      metadataCoreDb: input.restored.metadataCoreDb,
      accountCoreByBindingRef: input.restored.accountCoreByBindingRef,
      accountPiiByBindingRef: input.restored.accountPiiByBindingRef,
      lookupRows: lookup.lookupRows,
      coreAccountRouteGenerations: lookup.coreAccountRouteGenerations,
      lookupReadKeys: input.awsLookupReadKeys,
    },
    stateDb: input.restored.stateDb,
    authenticationState: input.restored.authenticationState,
    auditPorts: input.auditPorts,
    settings,
    configuration: {
      get: async (key) =>
        key === 'flag:ENABLE_LOGIN_RUNTIME_FLOW'
          ? String(input.supplement.sourceFlowRuntimeEnabled)
          : null,
    },
    signingBundle: saml,
    pairwiseSecret: secret,
    spEntityIds: input.spEntityIds,
    identityMappings: mappings,
    consentIpSalt: input.supplement.consentIpSalt,
    flowRuntimeHmacSecret: input.awsFlowRuntimeHmacSecret,
    assertSnapshotReady: () => input.assertSnapshotReady(),
  });
}
