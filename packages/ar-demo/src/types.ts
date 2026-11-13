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
}

export interface DemoDatabase {
  prepare(sql: string): DemoStatement;
}

export interface Env {
  DB: DemoDatabase;
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
}

/** What the handlers need from the outside world; the tests replace both. */
export interface Deps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

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
}
