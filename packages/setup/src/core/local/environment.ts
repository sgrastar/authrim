/**
 * Local development environment model.
 *
 * Local mode synthesises the same `AuthrimConfig` / `AuthrimLock` shapes the Cloudflare flow
 * persists, then feeds them to the shared generators. Nothing here talks to Cloudflare: D1
 * databases and KV namespaces exist only as Miniflare state, so their identifiers are the
 * deterministic names below.
 */

import { AuthrimConfigSchema, type AuthrimConfig } from '../config.js';
import { AuthrimLockSchema, type AuthrimLock } from '../lock.js';
import {
  CORE_WORKER_COMPONENTS,
  D1_DATABASES,
  KV_NAMESPACES,
  getD1DatabaseName,
  getKVNamespaceName,
  type WorkerComponent,
} from '../naming.js';
import {
  bootstrapDatabaseName,
  initialTenantShardDefinitions,
} from '../control-plane-bootstrap.js';
import { assertValidLocalEnvironmentName } from './paths.js';

export const LOCAL_DEFAULT_PORTS = {
  router: 8787,
  loginUi: 5173,
  adminUi: 5174,
} as const;

export interface LocalEnvironmentOptions {
  env: string;
  routerPort?: number;
  loginUiPort?: number;
  adminUiPort?: number;
  adminUiVariant?: 'legacy' | 'console';
  tenantName?: string;
}

export function localApiOrigin(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Local configuration. The Login UI and Admin UI each run their own Vite dev server and are
 * reached on their own localhost ports, like the dedicated UI origins of a deployment. They cannot
 * share the issuer origin: both dev servers serve the same module paths (/@vite/, /@fs/, ...) and
 * Vite's page HTML requests them from the page origin. Localhost ports are one browser site, so
 * cookies are shared and the UI calls the API directly (CORS allows the UI origins).
 */
export function buildLocalConfig(options: LocalEnvironmentOptions): AuthrimConfig {
  assertValidLocalEnvironmentName(options.env);
  const routerPort = options.routerPort ?? LOCAL_DEFAULT_PORTS.router;
  const loginUiPort = options.loginUiPort ?? LOCAL_DEFAULT_PORTS.loginUi;
  const adminUiPort = options.adminUiPort ?? LOCAL_DEFAULT_PORTS.adminUi;
  if (new Set([routerPort, loginUiPort, adminUiPort]).size !== 3) {
    throw new Error(
      `The router (${routerPort}), Login UI (${loginUiPort}) and Admin UI (${adminUiPort}) need three different ports.`
    );
  }
  return AuthrimConfigSchema.parse({
    environment: { prefix: options.env },
    urls: {
      api: { auto: localApiOrigin(routerPort) },
      loginUi: { auto: localApiOrigin(loginUiPort), sameAsApi: false },
      adminUi: { auto: localApiOrigin(adminUiPort), sameAsApi: false },
    },
    tenant: { name: options.tenantName ?? 'default' },
    components: { adminUiVariant: options.adminUiVariant ?? 'legacy' },
    features: {
      r2: { enabled: false },
      queue: { enabled: false },
      email: { provider: 'none' },
    },
    // Local mode has no Control Worker to provision capacity or refresh credentials.
    controlPlane: { automaticProvisioning: false },
    keys: { storageType: 'external' },
  });
}

/** The tenant shard bindings and fixed databases a local environment always has. */
export function listLocalD1Databases(env: string): Array<{ binding: string; name: string }> {
  return [
    ...D1_DATABASES.map((database) => ({
      binding: database.binding as string,
      name: getD1DatabaseName(env, database.dbType),
    })),
    ...initialTenantShardDefinitions(env).map((definition) => ({
      binding: definition.binding,
      name: bootstrapDatabaseName(env, definition.nameRole),
    })),
  ];
}

export function listLocalKvNamespaces(env: string): Array<{ binding: string; title: string }> {
  return KV_NAMESPACES.map((binding) => ({
    binding: binding as string,
    title: getKVNamespaceName(env, binding),
  }));
}

/**
 * Synthetic lock. D1 IDs equal the database name, which is exactly what `wrangler d1 execute
 * --local` resolves, so the same value works for the seeding commands and for `wrangler dev`.
 */
export function buildLocalLock(env: string, now: Date = new Date()): AuthrimLock {
  return AuthrimLockSchema.parse({
    env,
    createdAt: now.toISOString(),
    d1: Object.fromEntries(
      listLocalD1Databases(env).map(({ binding, name }) => [binding, { id: name, name }])
    ),
    kv: Object.fromEntries(
      listLocalKvNamespaces(env).map(({ binding, title }) => [binding, { id: title, name: title }])
    ),
  });
}

export const LOCAL_SELECTABLE_COMPONENTS: readonly WorkerComponent[] = CORE_WORKER_COMPONENTS;

/** Components that must run for any other Worker to function. */
const LOCAL_REQUIRED_COMPONENTS: readonly WorkerComponent[] = ['ar-lib-core', 'ar-router'];

export interface LocalComponentSelection {
  /** Workers started by `wrangler dev`, router first (it is the primary Worker). */
  running: WorkerComponent[];
  /** Selectable Workers that were left out through `--only`. */
  excluded: WorkerComponent[];
}

export function selectLocalComponents(only?: readonly string[]): LocalComponentSelection {
  let requested: WorkerComponent[];
  if (only && only.length > 0) {
    const known = new Set<string>(CORE_WORKER_COMPONENTS);
    requested = [];
    for (const name of only) {
      const normalized = (name.startsWith('ar-') ? name : `ar-${name}`) as WorkerComponent;
      if (!known.has(normalized)) {
        throw new Error(
          `Unknown component "${name}". Choose from: ${LOCAL_SELECTABLE_COMPONENTS.join(', ')}`
        );
      }
      requested.push(normalized);
    }
    requested.push(...LOCAL_REQUIRED_COMPONENTS);
    // Every administrative write passes the release-rollout fence, which asks ar-control.
    if (requested.includes('ar-management')) requested.push('ar-control');
  } else {
    requested = [...LOCAL_SELECTABLE_COMPONENTS];
  }
  const wanted = new Set(requested);
  const running = LOCAL_SELECTABLE_COMPONENTS.filter((component) => wanted.has(component));
  // Router first: wrangler treats the first `-c` as the primary (publicly reachable) Worker.
  running.sort((left, right) => Number(right === 'ar-router') - Number(left === 'ar-router'));
  return {
    running,
    excluded: LOCAL_SELECTABLE_COMPONENTS.filter((component) => !wanted.has(component)),
  };
}
