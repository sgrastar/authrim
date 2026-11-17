/**
 * The portal's own bindings. The database is described by the few D1 methods this package uses, so
 * the package declares no storage binding type of the platform and the tests can run real SQL
 * behind a small adapter.
 */
export interface DemoRunResult {
  meta: { changes: number };
}

export interface DemoStatement {
  bind(...values: unknown[]): DemoStatement;
  run(): Promise<DemoRunResult>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface DemoDatabase {
  prepare(sql: string): DemoStatement;
}

/** The one method of a service binding this package uses. */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: DemoDatabase;
  /**
   * Optional service binding to the Authrim router Worker. When present, every request to
   * ADMIN_API_ORIGIN (token endpoint and Admin API) goes through it instead of the public
   * internet; needed when the portal shares a zone with a router that is bound by zone routes.
   */
  AUTHRIM_API?: ServiceBinding;
  ADMIN_API_ORIGIN?: string;
  CONSOLE_ORIGIN?: string;
  PORTAL_ORIGIN?: string;
  TURNSTILE_SITE_KEY?: string;
  MAX_ACTIVE_TENANTS?: string | number;
  MAX_STARTS_PER_IP_PER_DAY?: string | number;
  TENANT_TTL_HOURS?: string | number;
  ENVIRONMENT?: string;
  TURNSTILE_SECRET_KEY?: string;
  MACHINE_CLIENT_ID?: string;
  MACHINE_KEY_ID?: string;
  MACHINE_PRIVATE_JWK?: string;
  IP_HASH_SECRET?: string;
  DEFAULT_TENANT_ID?: string;
  SWEEP_ENABLED?: string;
  SWEEP_DRY_RUN?: string;
  SWEEP_MIN_AGE_MINUTES?: string | number;
  SWEEP_MAX_DELETES_PER_RUN?: string | number;
  SWEEP_MAX_PAGES?: string | number;
  SWEEP_KEEP_USER_IDS?: string;
  SWEEP_MACHINE_CLIENT_ID?: string;
  SWEEP_MACHINE_KEY_ID?: string;
  SWEEP_MACHINE_PRIVATE_JWK?: string;
}

/** What the handlers need from the outside world; the tests replace both. */
export interface Deps {
  /** The public internet (global fetch). Only for third parties such as Turnstile. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * Calls to the Authrim API (token endpoint and Admin API) and nothing else: through the
   * AUTHRIM_API service binding when it is bound, otherwise over the public internet.
   */
  authrimFetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

const globalFetch: Deps['fetch'] = (input, init) => fetch(input, init);

/**
 * The single place that chooses how Authrim API requests leave the Worker. A URL whose origin is
 * not the configured ADMIN_API_ORIGIN is refused, so the binding can never carry anything else.
 */
export function createDeps(env: Env): Deps {
  const binding = env.AUTHRIM_API;
  let authrimFetch: Deps['authrimFetch'] = globalFetch;
  if (binding) {
    authrimFetch = (input, init) => {
      let allowed: string | null = null;
      try {
        allowed = env.ADMIN_API_ORIGIN ? new URL(env.ADMIN_API_ORIGIN).origin : null;
      } catch {
        allowed = null;
      }
      let origin: string | null = null;
      try {
        origin = new URL(input).origin;
      } catch {
        origin = null;
      }
      if (!allowed || origin !== allowed) {
        return Promise.reject(new Error('authrim_api_origin_mismatch'));
      }
      return binding.fetch(new Request(input, init));
    };
  }
  return { fetch: globalFetch, authrimFetch, now: () => Date.now() };
}

export type RegistryState =
  | 'provisioning'
  | 'inviting'
  | 'handed_off'
  | 'failed'
  | 'deleting'
  | 'deleted';

export interface RegistryRow {
  id: string;
  ticket_hash: string;
  ip_hash: string;
  state: RegistryState;
  created_at: number;
  expires_at: number;
  last_polled_at: number | null;
  updated_at: number;
  delete_attempted_at: number | null;
  delete_attempts: number;
  create_accepted_at: number | null;
  create_started_at: number | null;
  create_attempts: number;
}
