import {
  bootstrapControlWorkerTokens,
  CloudflareTokenBootstrapError,
  CloudflareTokenAuthorityHttpClient,
  WranglerControlSecretSink,
  type CloudflareTokenOwnership,
  type ControlSecretSink,
  type ControlTokenResourceClass,
} from './cloudflare-control-token-bootstrap.js';
import {
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
} from './control-provisioning-authority.js';
import type { AuthrimConfig } from './config.js';

const CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS = {
  d1: 'CLOUDFLARE_D1_API_TOKEN',
  workers: 'CLOUDFLARE_WORKERS_API_TOKEN',
  kv: 'CLOUDFLARE_KV_API_TOKEN',
  r2: 'CLOUDFLARE_R2_API_TOKEN',
} as const satisfies Record<ControlTokenResourceClass, Parameters<ControlSecretSink['has']>[0]>;

export function resolveControlTokenResourceClasses(
  config: Pick<AuthrimConfig, 'features'>
): readonly ControlTokenResourceClass[] {
  return config.features.pluginDynamicWorkers.enabled
    ? ['d1', 'workers', 'kv', 'r2']
    : ['d1', 'workers'];
}

export async function findMissingControlTokenResourceClasses(input: {
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: Pick<ControlSecretSink, 'has' | 'listNames'>;
}): Promise<ControlTokenResourceClass[]> {
  if (input.secretSink.listNames) {
    const presentNames = new Set(await input.secretSink.listNames());
    return input.resourceClasses.filter(
      (resourceClass) => !presentNames.has(CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass])
    );
  }
  const checks = await Promise.all(
    input.resourceClasses.map(async (resourceClass) => ({
      resourceClass,
      present: await input.secretSink.has(CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass]),
    }))
  );
  return checks.filter((check) => !check.present).map((check) => check.resourceClass);
}

export async function hasReadyControlTokenBootstrap(input: {
  environmentId: string;
  controlDatabaseName: string;
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: Pick<ControlSecretSink, 'has' | 'listNames'>;
  query?: Parameters<typeof readControlProvisioningAuthority>[0]['query'];
}): Promise<boolean> {
  const authority = await readControlProvisioningAuthority({
    environmentId: input.environmentId,
    controlDatabaseName: input.controlDatabaseName,
    query: input.query,
  });
  if (
    authority?.automaticProvisioningEnabled !== true ||
    authority.capabilityState !== 'ready' ||
    authority.tokenOwnership === 'none'
  ) {
    return false;
  }
  return (
    (
      await findMissingControlTokenResourceClasses({
        resourceClasses: input.resourceClasses,
        secretSink: input.secretSink,
      })
    ).length === 0
  );
}

export function classifyControlTokenBootstrapFailure(
  error: unknown,
  ownership: CloudflareTokenOwnership
): {
  tokenOwnership: CloudflareTokenOwnership | 'none';
  capabilityState: 'pending' | 'blocked';
} {
  return error instanceof CloudflareTokenBootstrapError && error.cleanupRequired
    ? { tokenOwnership: ownership, capabilityState: 'blocked' }
    : { tokenOwnership: 'none', capabilityState: 'pending' };
}

export async function completeControlTokenBootstrap(input: {
  accountId: string;
  environment: string;
  rootDir: string;
  controlDatabaseName: string;
  bootstrapToken: string;
  ownership: CloudflareTokenOwnership;
  resourceClasses: readonly ControlTokenResourceClass[];
}): Promise<void> {
  const authority = new CloudflareTokenAuthorityHttpClient({
    accountId: input.accountId,
    ownership: input.ownership,
    bootstrapToken: input.bootstrapToken,
  });
  try {
    await bootstrapControlWorkerTokens({
      accountId: input.accountId,
      environment: input.environment,
      ownership: input.ownership,
      resourceClasses: input.resourceClasses,
      authority,
      secretSink: new WranglerControlSecretSink({
        workerName: `${input.environment}-ar-control`,
        cwd: input.rootDir,
      }),
      beforeBootstrapRevocation: async () => {
        await writeControlProvisioningAuthority({
          controlDatabaseName: input.controlDatabaseName,
          environmentId: input.environment,
          automaticProvisioningEnabled: true,
          tokenOwnership: input.ownership,
          capabilityState: 'ready',
        });
      },
    });
  } catch (error) {
    const failureAuthority = classifyControlTokenBootstrapFailure(error, input.ownership);
    await writeControlProvisioningAuthority({
      controlDatabaseName: input.controlDatabaseName,
      environmentId: input.environment,
      automaticProvisioningEnabled: true,
      ...failureAuthority,
    }).catch(() => undefined);
    throw error;
  }
}
