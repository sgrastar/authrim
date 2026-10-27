import { pathToFileURL } from 'node:url';
import { canonicalRestoreJson, readPinnedRestoreFile } from './restore-evidence';
import {
  restoreOfflineAwsSamlTenant,
  type RestoreOfflineAwsSamlTenantInput,
} from './restore-offline';

/** Secrets are resolved from the process environment, never stored inline in the plan. */
export interface AwsOfflineRestorePlan {
  formatVersion: 1;
  backup: Omit<RestoreOfflineAwsSamlTenantInput['backup'], 'passphrase' | 'signal' | 'nowMs'> & {
    passphraseEnv: string;
  };
  supplement: RestoreOfflineAwsSamlTenantInput['supplement'];
  restoreId: string;
  core: Omit<RestoreOfflineAwsSamlTenantInput['core'], 'connectionString'> & {
    connectionStringEnv: string;
  };
  pii: Omit<RestoreOfflineAwsSamlTenantInput['pii'], 'connectionString'> & {
    connectionStringEnv: string;
  };
  state: Omit<RestoreOfflineAwsSamlTenantInput['state'], 'connectionString'> & {
    connectionStringEnv: string;
  };
  environmentName: string;
  spEntityIds: readonly string[];
  allocationScope: RestoreOfflineAwsSamlTenantInput['allocationScope'];
  awsFlowRuntimeHmacSecretEnv: string;
  awsLookupReadKeys: readonly { generation: number; secretEnv: string }[];
}

function invalid(): never {
  throw new Error('aws_restore_plan_invalid');
}

function exactKeys(value: object, expected: readonly string[]) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    invalid();
}

export function resolveAwsOfflineRestorePlan(
  plan: AwsOfflineRestorePlan,
  environment: Readonly<Record<string, string | undefined>>
): RestoreOfflineAwsSamlTenantInput {
  try {
    exactKeys(plan, [
      'formatVersion',
      'backup',
      'supplement',
      'restoreId',
      'core',
      'pii',
      'state',
      'environmentName',
      'spEntityIds',
      'allocationScope',
      'awsFlowRuntimeHmacSecretEnv',
      'awsLookupReadKeys',
    ]);
    if (plan.formatVersion !== 1) invalid();
    exactKeys(plan.backup, [
      'partPaths',
      'receipt',
      'selection',
      'datasets',
      'maxSnapshotAgeMs',
      'passphraseEnv',
    ]);
    exactKeys(plan.supplement, ['path', 'expectedSha256']);
    exactKeys(plan.core, ['connectionStringEnv', 'targetId', 'bindingRefs']);
    exactKeys(plan.pii, ['connectionStringEnv', 'targetId', 'bindingRefs']);
    exactKeys(plan.state, ['connectionStringEnv', 'initializeEmptySchema']);
    if (
      typeof plan.state.initializeEmptySchema !== 'boolean' ||
      !Array.isArray(plan.awsLookupReadKeys as unknown) ||
      plan.awsLookupReadKeys.length < 1 ||
      plan.awsLookupReadKeys.length > 2
    )
      invalid();
    const secret = (name: string) => {
      if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) invalid();
      const value = environment[name];
      if (!value) invalid();
      return value;
    };
    const { passphraseEnv, ...backup } = plan.backup;
    const { connectionStringEnv: coreEnv, ...core } = plan.core;
    const { connectionStringEnv: piiEnv, ...pii } = plan.pii;
    const { connectionStringEnv: stateEnv, ...state } = plan.state;
    return {
      backup: { ...backup, passphrase: secret(passphraseEnv) },
      supplement: plan.supplement,
      restoreId: plan.restoreId,
      core: { ...core, connectionString: secret(coreEnv) },
      pii: { ...pii, connectionString: secret(piiEnv) },
      state: { ...state, connectionString: secret(stateEnv) },
      environmentName: plan.environmentName,
      spEntityIds: plan.spEntityIds,
      allocationScope: plan.allocationScope,
      awsFlowRuntimeHmacSecret: secret(plan.awsFlowRuntimeHmacSecretEnv),
      awsLookupReadKeys: plan.awsLookupReadKeys.map((key) => {
        exactKeys(key, ['generation', 'secretEnv']);
        return { generation: key.generation, secret: secret(key.secretEnv) };
      }),
    };
  } catch {
    return invalid();
  }
}

export async function runAwsOfflineRestoreCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node dist/restore-cli.mjs --plan /absolute/plan.json --plan-sha256 <trusted SHA256>\n'
    );
    return;
  }
  try {
    if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--plan-sha256') invalid();
    const bytes = await readPinnedRestoreFile(args[1], args[3], 4 * 1024 * 1024);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const plan = JSON.parse(raw) as AwsOfflineRestorePlan;
    if (canonicalRestoreJson(plan) !== raw) invalid();
    const input = resolveAwsOfflineRestorePlan(plan, process.env);
    const restored = await restoreOfflineAwsSamlTenant(input);
    try {
      // This receipt contains identities and hashes, never credentials or imported row contents.
      process.stdout.write(
        `${canonicalRestoreJson({ status: 'active', evidence: restored.evidence })}\n`
      );
    } finally {
      await restored.close();
    }
  } catch {
    process.stderr.write('aws_offline_restore_failed\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAwsOfflineRestoreCli(process.argv.slice(2));
}
