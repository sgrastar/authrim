import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';
import { deriveEncryptionKey, encryptValue } from '@authrim/ar-lib-plugin';
import {
  type PluginEncryptionKeyring,
  validatePluginEncryptionKeyring,
} from './encryption-keyring';
import { isApprovedCredentialInjectionHeader } from './egress-headers';

const MAX_CREDENTIALS = 16;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_HEADER = /^[A-Za-z0-9-]{1,64}$/u;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface PluginCredentialInput {
  configKey: string;
  destinationHost: string;
  injectionKind: 'header' | 'bearer' | 'json_field' | 'form_field';
  injectionName: string;
  value: string;
}

export interface ReplacePluginCredentialsInput {
  operationId: string;
  tenantId: string;
  installationId: string;
  expectedConfigVersion: number;
  credentials: PluginCredentialInput[];
}

export interface ReplacePluginCredentialsResult {
  operationId: string;
  installationId: string;
  configVersion: number;
  credentialCount: number;
}

interface InstallationRow {
  plugin_id: string;
  state: string;
  config_version: number | string;
  backend_kind: string;
  dynamic_version_digest: string | null;
}

interface MutationRow {
  installation_id: string;
  tenant_id: string;
  request_fingerprint: string;
  fingerprint_key_id: string;
  target_config_version: number | string;
  state: string;
}

interface CredentialSlotRow {
  config_key: string;
  required: number | string;
  destination_host: string;
  injection_kind: string;
  injection_name: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_config_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function validate(input: unknown): asserts input is ReplacePluginCredentialsInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_config_input_invalid');
  }
  const value = input as Partial<ReplacePluginCredentialsInput>;
  if (
    Object.keys(input).sort().join(',') !==
      'credentials,expectedConfigVersion,installationId,operationId,tenantId' ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.installationId !== 'string' ||
    !SAFE_ID.test(value.installationId) ||
    !Number.isSafeInteger(value.expectedConfigVersion) ||
    (value.expectedConfigVersion as number) < 1 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > MAX_CREDENTIALS
  ) {
    throw new Error('plugin_config_input_invalid');
  }
  const keys = new Set<string>();
  const injectionTargets = new Set<string>();
  for (const credential of value.credentials) {
    const injectionTarget =
      credential &&
      typeof credential.destinationHost === 'string' &&
      typeof credential.injectionName === 'string'
        ? `${credential.destinationHost}:${credential.injectionName.toLowerCase()}`
        : '';
    if (
      !credential ||
      Object.keys(credential).sort().join(',') !==
        'configKey,destinationHost,injectionKind,injectionName,value' ||
      !SAFE_CONFIG_KEY.test(credential.configKey) ||
      !SAFE_HOST.test(credential.destinationHost) ||
      credential.destinationHost !== credential.destinationHost.toLowerCase() ||
      !['header', 'bearer', 'json_field', 'form_field'].includes(credential.injectionKind) ||
      !SAFE_FIELD.test(credential.injectionName) ||
      ((credential.injectionKind === 'header' || credential.injectionKind === 'bearer') &&
        (!SAFE_HEADER.test(credential.injectionName) ||
          !isApprovedCredentialInjectionHeader(
            credential.injectionKind,
            credential.injectionName
          ))) ||
      typeof credential.value !== 'string' ||
      credential.value.length < 1 ||
      credential.value.length > 8_192 ||
      keys.has(credential.configKey) ||
      injectionTargets.has(injectionTarget)
    ) {
      throw new Error('plugin_config_input_invalid');
    }
    keys.add(credential.configKey);
    injectionTargets.add(injectionTarget);
  }
}

function aad(input: {
  tenantId: string;
  pluginId: string;
  configKey: string;
  configVersion: number;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([input.tenantId, input.pluginId, input.configKey, input.configVersion])
  );
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertBatch(results: D1Result<unknown>[], expected: number): void {
  if (
    results.length !== expected ||
    results.some(
      (result) =>
        result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1
    )
  ) {
    throw new Error('plugin_config_batch_failed');
  }
}

export class D1PluginConfigStore {
  private readonly keyring: PluginEncryptionKeyring;
  private readonly fingerprintSecret: string;

  constructor(
    private readonly db: D1Database,
    encryption: string | PluginEncryptionKeyring,
    fingerprintSecret: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.keyring = validatePluginEncryptionKeyring(
      typeof encryption === 'string' ? { active: { id: 'v1', secret: encryption } } : encryption
    );
    if (fingerprintSecret.length < 32) throw new Error('plugin_config_hmac_key_invalid');
    this.fingerprintSecret = fingerprintSecret;
  }

  async replaceCredentials(input: unknown): Promise<ReplacePluginCredentialsResult> {
    validate(input);
    const session = primary(this.db);
    const canonical = JSON.stringify({
      operationId: input.operationId,
      tenantId: input.tenantId,
      installationId: input.installationId,
      expectedConfigVersion: input.expectedConfigVersion,
      credentials: [...input.credentials]
        .sort((left, right) => left.configKey.localeCompare(right.configKey))
        .map((credential) => ({
          configKey: credential.configKey,
          destinationHost: credential.destinationHost,
          injectionKind: credential.injectionKind,
          injectionName: credential.injectionName,
          value: credential.value,
        })),
    });
    const existing = await session
      .prepare(
        `SELECT installation_id, tenant_id, request_fingerprint, fingerprint_key_id,
                target_config_version, state
           FROM plugin_runner_config_mutations WHERE operation_id = ?`
      )
      .bind(input.operationId)
      .first<MutationRow>();
    if (existing) {
      if (existing.fingerprint_key_id !== 'mutation-v1') {
        throw new Error('plugin_config_idempotency_conflict');
      }
      const retryFingerprint = await hmacHex(this.fingerprintSecret, canonical);
      if (
        existing.installation_id !== input.installationId ||
        existing.tenant_id !== input.tenantId ||
        existing.request_fingerprint !== retryFingerprint ||
        existing.state !== 'applied'
      ) {
        throw new Error('plugin_config_idempotency_conflict');
      }
      return {
        operationId: input.operationId,
        installationId: input.installationId,
        configVersion: integer(existing.target_config_version, 'plugin_config_version_invalid'),
        credentialCount: input.credentials.length,
      };
    }

    const requestFingerprint = await hmacHex(this.fingerprintSecret, canonical);

    const installation = await session
      .prepare(
        `SELECT plugin_id, state, config_version, backend_kind, NULL AS dynamic_version_digest
           FROM plugin_runner_installations
          WHERE installation_id = ? AND tenant_id = ? AND state IN ('disabled', 'enabled')`
      )
      .bind(input.installationId, input.tenantId)
      .first<InstallationRow>();
    if (
      !installation ||
      !SAFE_ID.test(installation.plugin_id) ||
      (installation.backend_kind !== 'dynamic_worker' && installation.backend_kind !== 'in_process')
    ) {
      throw new Error('plugin_config_installation_unavailable');
    }
    const currentVersion = integer(installation.config_version, 'plugin_config_version_invalid');
    if (currentVersion !== input.expectedConfigVersion) {
      throw new Error('plugin_config_version_conflict');
    }
    const targetVersion = currentVersion + 1;
    if (!Number.isSafeInteger(targetVersion)) throw new Error('plugin_config_version_invalid');

    const dynamicVersion =
      installation.backend_kind === 'dynamic_worker'
        ? await session
            .prepare(
              `SELECT CASE WHEN installation.state = 'enabled'
                        THEN artifact.version_digest ELSE manifest.active_version_digest END
                        AS version_digest
                 FROM plugin_runner_installations installation
                 LEFT JOIN plugin_runner_dynamic_worker_artifacts artifact
                   ON artifact.installation_id = installation.installation_id
                  AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
                 JOIN plugin_runner_dynamic_worker_manifests manifest
                   ON manifest.plugin_id = installation.plugin_id AND manifest.state = 'active'
                 JOIN plugin_runner_dynamic_worker_releases release
                   ON release.plugin_id = installation.plugin_id
                  AND release.version_digest = CASE WHEN installation.state = 'enabled'
                    THEN artifact.version_digest ELSE manifest.active_version_digest END
                  AND release.state = 'published'
                WHERE installation.installation_id = ? AND installation.tenant_id = ?`
            )
            .bind(input.installationId, input.tenantId)
            .first<{ version_digest: string }>()
        : null;
    const dynamicVersionDigest = dynamicVersion?.version_digest ?? null;
    if (installation.backend_kind === 'dynamic_worker' && !dynamicVersionDigest) {
      throw new Error('plugin_config_installation_unavailable');
    }
    const approvedHosts = await session
      .prepare(
        installation.backend_kind === 'dynamic_worker'
          ? `SELECT host_pattern FROM plugin_runner_dynamic_worker_egress_allowed_hosts
              WHERE plugin_id = ? AND version_digest = ? AND match_kind = 'exact'
              ORDER BY host_pattern LIMIT 101`
          : `SELECT host_pattern FROM plugin_runner_egress_allowed_hosts
              WHERE plugin_id = ? AND match_kind = 'exact' ORDER BY host_pattern LIMIT 101`
      )
      .bind(
        ...(installation.backend_kind === 'dynamic_worker'
          ? [installation.plugin_id, dynamicVersionDigest]
          : [installation.plugin_id])
      )
      .all<{ host_pattern: string }>();
    if (approvedHosts.results.length > 100) throw new Error('plugin_config_host_policy_invalid');
    const approved = new Set(approvedHosts.results.map((row) => row.host_pattern));
    if (input.credentials.some((credential) => !approved.has(credential.destinationHost))) {
      throw new Error('plugin_config_host_not_approved');
    }
    if (installation.backend_kind === 'dynamic_worker') {
      const slots = await session
        .prepare(
          `SELECT config_key, required, destination_host, injection_kind, injection_name
           FROM plugin_runner_dynamic_worker_credential_slots
            WHERE plugin_id = ? AND version_digest = ? ORDER BY config_key LIMIT 17`
        )
        .bind(installation.plugin_id, dynamicVersionDigest)
        .all<CredentialSlotRow>();
      if (slots.results.length > MAX_CREDENTIALS) {
        throw new Error('plugin_config_credential_policy_invalid');
      }
      const byKey = new Map(slots.results.map((slot) => [slot.config_key, slot]));
      for (const credential of input.credentials) {
        const slot = byKey.get(credential.configKey);
        if (
          !slot ||
          slot.destination_host !== credential.destinationHost ||
          slot.injection_kind !== credential.injectionKind ||
          slot.injection_name.toLowerCase() !== credential.injectionName.toLowerCase()
        ) {
          throw new Error('plugin_config_credential_slot_mismatch');
        }
      }
      const provided = new Set(input.credentials.map((credential) => credential.configKey));
      if (
        slots.results.some((slot) => Number(slot.required) === 1 && !provided.has(slot.config_key))
      ) {
        throw new Error('plugin_config_required_credential_missing');
      }
    }

    const key = await deriveEncryptionKey(this.keyring.active.secret);
    const encrypted = await Promise.all(
      input.credentials.map(async (credential) => {
        const encryptedValue = await encryptValue(
          credential.value,
          key,
          aad({
            tenantId: input.tenantId,
            pluginId: installation.plugin_id,
            configKey: credential.configKey,
            configVersion: targetVersion,
          })
        );
        const parts = encryptedValue.split(':');
        if (parts.length !== 4 || !parts[2]) throw new Error('plugin_config_envelope_invalid');
        return {
          ...credential,
          encryptedValue,
          nonceFingerprint: await hmacHex(
            this.keyring.active.secret,
            `${this.keyring.active.id}:${parts[2]}`
          ),
        };
      })
    );
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) throw new Error('plugin_config_now_invalid');
    const statements = [
      session
        .prepare(
          `INSERT INTO plugin_runner_config_mutations (
             operation_id, installation_id, tenant_id, request_fingerprint,
             fingerprint_key_id, target_config_version, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'applying', ?, ?)`
        )
        .bind(
          input.operationId,
          input.installationId,
          input.tenantId,
          requestFingerprint,
          'mutation-v1',
          targetVersion,
          now,
          now
        ),
      ...encrypted.map((credential) =>
        session
          .prepare(
            `INSERT INTO plugin_runner_encrypted_configs (
               installation_id, config_key, config_version, injection_kind, injection_name,
               destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
               reencrypt_state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`
          )
          .bind(
            input.installationId,
            credential.configKey,
            targetVersion,
            credential.injectionKind,
            credential.injectionName,
            credential.destinationHost,
            this.keyring.active.id,
            credential.encryptedValue,
            credential.nonceFingerprint,
            now,
            now
          )
      ),
      session
        .prepare(
          `UPDATE plugin_runner_installations SET config_version = ?, updated_at = ?
            WHERE installation_id = ? AND tenant_id = ? AND config_version = ?`
        )
        .bind(targetVersion, now, input.installationId, input.tenantId, currentVersion),
      session
        .prepare(
          `UPDATE plugin_runner_config_mutations
              SET state = 'applied', applied_at = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'applying'`
        )
        .bind(now, now, input.operationId),
    ];
    assertBatch(await session.batch(statements), statements.length);
    return {
      operationId: input.operationId,
      installationId: input.installationId,
      configVersion: targetVersion,
      credentialCount: input.credentials.length,
    };
  }
}
