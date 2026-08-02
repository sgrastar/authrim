import { executeD1Command, queryD1Rows } from './cloudflare.js';
import type { CloudflareTokenOwnership } from './cloudflare-control-token-bootstrap.js';

const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type ControlProvisioningCapabilityState = 'disabled' | 'pending' | 'ready' | 'blocked';

export interface ControlProvisioningAuthorityState {
  environmentId: string;
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | CloudflareTokenOwnership;
  capabilityState: ControlProvisioningCapabilityState;
  capabilityCheckedAt: number | null;
  updatedAt: number;
}

export function isTokenlessPendingControlProvisioningAuthority(
  authority: ControlProvisioningAuthorityState | null
): authority is ControlProvisioningAuthorityState {
  return (
    authority?.automaticProvisioningEnabled === true &&
    authority.capabilityState === 'pending' &&
    authority.tokenOwnership === 'none'
  );
}

interface ProvisioningAuthorityRow extends Record<string, unknown> {
  environment_id: string;
  automatic_provisioning_enabled: number;
  provisioning_token_ownership: 'none' | CloudflareTokenOwnership;
  provisioning_capability_state: ControlProvisioningCapabilityState;
  provisioning_capability_checked_at: number | null;
  updated_at: number;
}

function requiredEnvironmentId(environmentId: string): string {
  if (!SAFE_ENVIRONMENT.test(environmentId)) {
    throw new Error('control_provisioning_authority_environment_invalid');
  }
  return environmentId;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stateFromRow(row: ProvisioningAuthorityRow): ControlProvisioningAuthorityState {
  return {
    environmentId: row.environment_id,
    automaticProvisioningEnabled: row.automatic_provisioning_enabled === 1,
    tokenOwnership: row.provisioning_token_ownership,
    capabilityState: row.provisioning_capability_state,
    capabilityCheckedAt: row.provisioning_capability_checked_at,
    updatedAt: row.updated_at,
  };
}

export async function readControlProvisioningAuthority(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ControlProvisioningAuthorityState | null> {
  const environmentId = requiredEnvironmentId(input.environmentId);
  const rows = await (input.query ?? queryD1Rows)<ProvisioningAuthorityRow>(
    input.controlDatabaseName,
    `SELECT environment_id, automatic_provisioning_enabled, provisioning_token_ownership,
            provisioning_capability_state, provisioning_capability_checked_at, updated_at
       FROM control_environments
      WHERE environment_id = ${sqlString(environmentId)}
      LIMIT 1`
  );
  return rows[0] ? stateFromRow(rows[0]) : null;
}

export async function writeControlProvisioningAuthority(input: {
  controlDatabaseName: string;
  environmentId: string;
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | CloudflareTokenOwnership;
  capabilityState: ControlProvisioningCapabilityState;
  now?: number;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
}): Promise<ControlProvisioningAuthorityState> {
  const environmentId = requiredEnvironmentId(input.environmentId);
  const valid = input.automaticProvisioningEnabled
    ? (input.capabilityState === 'pending' && input.tokenOwnership === 'none') ||
      ((input.capabilityState === 'ready' || input.capabilityState === 'blocked') &&
        input.tokenOwnership !== 'none')
    : input.tokenOwnership === 'none' && input.capabilityState === 'disabled';
  if (!valid) throw new Error('control_provisioning_authority_state_invalid');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('control_provisioning_authority_timestamp_invalid');
  }
  const checkedAt = input.capabilityState === 'pending' ? 'NULL' : String(now);
  await (input.execute ?? executeD1Command)(
    input.controlDatabaseName,
    `UPDATE control_environments
        SET automatic_provisioning_enabled = ${input.automaticProvisioningEnabled ? 1 : 0},
            provisioning_token_ownership = ${sqlString(input.tokenOwnership)},
            provisioning_capability_state = ${sqlString(input.capabilityState)},
            provisioning_capability_checked_at = ${checkedAt},
            updated_at = ${now}
      WHERE environment_id = ${sqlString(environmentId)}`
  );
  const reflected = await readControlProvisioningAuthority({
    controlDatabaseName: input.controlDatabaseName,
    environmentId,
    query: input.query,
  });
  if (
    !reflected ||
    reflected.automaticProvisioningEnabled !== input.automaticProvisioningEnabled ||
    reflected.tokenOwnership !== input.tokenOwnership ||
    reflected.capabilityState !== input.capabilityState ||
    (input.capabilityState !== 'pending' && reflected.capabilityCheckedAt !== now)
  ) {
    throw new Error('control_provisioning_authority_reflection_failed');
  }
  return reflected;
}
