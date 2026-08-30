import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { WorkerComponent } from './naming.js';

export const MANAGED_WORKER_DEPLOY_BUILD_COMMAND =
  'node ../../scripts/guard-managed-worker-deploy.mjs';

const MANAGED_WORKER_DEPLOY_TICKET_TTL_MS = 5 * 60_000;

interface ManagedWorkerDeployTicketPayload {
  schemaVersion: 2;
  wranglerCommand: 'deploy' | 'versions upload';
  component: WorkerComponent;
  environment: string;
  workerName: string;
  configPath: string;
  configDigest: string;
  expiresAt: number;
  nonceDigest: string;
}

export interface ManagedWorkerDeployTicket {
  env: Readonly<Record<string, string>>;
  assertConsumed: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function digestNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('base64url');
}

function resolveConfigPath(packageDir: string, configFile: string | undefined): string {
  const selected = configFile ?? 'wrangler.toml';
  return isAbsolute(selected) ? selected : resolve(packageDir, selected);
}

export async function hasManagedWorkerDeployGuard(
  packageDir: string,
  configFile?: string
): Promise<boolean> {
  const content = await readFile(resolveConfigPath(packageDir, configFile), 'utf8');
  return content.includes(`[build]\ncommand = "${MANAGED_WORKER_DEPLOY_BUILD_COMMAND}"`);
}

/**
 * Create a short-lived, one-use process capability consumed by the generated Wrangler build guard.
 * This prevents an accidental raw `wrangler deploy` from using setup-managed production config.
 */
export async function createManagedWorkerDeployTicket(input: {
  wranglerCommand: 'deploy' | 'versions upload';
  component: WorkerComponent;
  environment: string;
  workerName: string;
  packageDir: string;
  configFile?: string;
  now?: number;
}): Promise<ManagedWorkerDeployTicket | undefined> {
  if (!(await hasManagedWorkerDeployGuard(input.packageDir, input.configFile))) {
    return undefined;
  }

  const directory = await mkdtemp(join(tmpdir(), 'authrim-managed-worker-deploy-'));
  const ticketPath = join(directory, 'ticket.json');
  const consumedPath = join(directory, 'consumed');
  const configPath = await realpath(resolveConfigPath(input.packageDir, input.configFile));
  const configDigest = createHash('sha256')
    .update(await readFile(configPath, 'utf8'), 'utf8')
    .digest('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const issuedAt = input.now ?? Date.now();
  const payload: ManagedWorkerDeployTicketPayload = {
    schemaVersion: 2,
    wranglerCommand: input.wranglerCommand,
    component: input.component,
    environment: input.environment,
    workerName: input.workerName,
    configPath,
    configDigest,
    expiresAt: issuedAt + MANAGED_WORKER_DEPLOY_TICKET_TTL_MS,
    nonceDigest: digestNonce(nonce),
  };

  try {
    await writeFile(ticketPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await chmod(ticketPath, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    env: {
      AUTHRIM_MANAGED_DEPLOY_TICKET: ticketPath,
      AUTHRIM_MANAGED_DEPLOY_NONCE: nonce,
      AUTHRIM_MANAGED_DEPLOY_COMPONENT: input.component,
      AUTHRIM_MANAGED_DEPLOY_ENVIRONMENT: input.environment,
      AUTHRIM_MANAGED_DEPLOY_WORKER_NAME: input.workerName,
      AUTHRIM_MANAGED_DEPLOY_WRANGLER_COMMAND: input.wranglerCommand,
    },
    assertConsumed: async () => {
      const consumed = await stat(consumedPath).catch(() => undefined);
      if (!consumed?.isFile()) {
        throw new Error(`managed_worker_deploy_guard_not_consumed:${basename(input.packageDir)}`);
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
