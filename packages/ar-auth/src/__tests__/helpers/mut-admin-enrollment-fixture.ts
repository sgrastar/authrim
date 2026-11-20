/**
 * In-memory doubles for the admin invitation enrollment routes (mut-admin-* tests).
 * Kept free of '@authrim/ar-lib-core' so it can be loaded from vi.hoisted.
 */
import { vi } from 'vitest';

export interface StoredEnrollment {
  invitation_id: string;
  phase: string;
  state_json: string;
  expires_at: number;
}

/** The option bag the routes pass to @simplewebauthn/server, as far as the tests read it. */
export interface WebAuthnArgs {
  userID?: Uint8Array;
  userDisplayName?: string;
  credential?: { id: string; publicKey: Uint8Array; counter: number };
  [key: string]: unknown;
}

export function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

export interface Statement {
  sql: string;
  params?: unknown[];
}

export function baseInvitation(): Record<string, unknown> {
  return {
    id: 'invitation_1',
    tenant_id: 'tenant_123',
    admin_user_id: 'admin_new',
    email: 'new-admin@example.com',
    name: 'New Admin',
    status: 'pending',
    admin_role_id: 'role_ar_tenant_admin',
    role_name: 'admin',
    role_display_name: 'Administrator',
    scope_type: 'tenant',
    scope_id: 'tenant_123',
    role_expires_at: null,
    ip_restriction_enabled: 0,
    allowed_ip_ranges_json: '[]',
    expires_at: Date.now() + 60_000,
    created_by: 'admin_actor',
  };
}

export async function sha256Hex(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createEnrollmentFixture() {
  const enrollments = new Map<string, StoredEnrollment>();
  const secondFactors = new Set<string>();
  const state = {
    invitation: baseInvitation() as Record<string, unknown> | null,
    namedGroups: [] as Array<Record<string, unknown>>,
    missedGroups: [] as Array<Record<string, unknown>>,
    updateRowsAffected: null as number | null,
  };
  const adapter = {
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM admin_invitation_enrollments')) {
        const row = enrollments.get(String(params[0]));
        return row && row.expires_at > Number(params[1]) ? { state_json: row.state_json } : null;
      }
      if (sql.includes('FROM admin_second_factors')) {
        return secondFactors.has(String(params[0])) ? { id: 'second-factor' } : null;
      }
      return state.invitation ? { ...state.invitation } : null;
    }),
    query: vi.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('m.id IS NULL')) return state.missedGroups;
      if (sql.includes('group_revision')) return state.namedGroups;
      return [];
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO admin_invitation_enrollments')) {
        enrollments.set(String(params[0]), {
          invitation_id: String(params[1]),
          phase: String(params[2]),
          state_json: String(params[3]),
          expires_at: Number(params[4]),
        });
        return { rowsAffected: 1 };
      }
      if (sql.includes('UPDATE admin_invitation_enrollments')) {
        if (state.updateRowsAffected !== null) return { rowsAffected: state.updateRowsAffected };
        const key = String(params[3]);
        const row = enrollments.get(key);
        if (!row || row.phase !== String(params[4]) || row.expires_at <= Number(params[5])) {
          return { rowsAffected: 0 };
        }
        enrollments.set(key, { ...row, phase: String(params[0]), state_json: String(params[1]) });
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 1 };
    }),
    batch: vi.fn(async (_statements: Statement[]): Promise<unknown[]> => []),
  };
  type WebAuthnFn = (options: WebAuthnArgs) => Promise<unknown>;
  const webauthn = {
    generateRegistrationOptions: vi.fn<WebAuthnFn>(),
    generateAuthenticationOptions: vi.fn<WebAuthnFn>(),
    verifyRegistrationResponse: vi.fn<WebAuthnFn>(),
    verifyAuthenticationResponse: vi.fn<WebAuthnFn>(),
  };
  const noticeCreate = vi.fn(async (_input: Record<string, unknown>) => ({ id: 'notice' }));
  const auditDispatch = vi.fn(async () => {});
  const auditRows: Array<Record<string, unknown>> = [];
  const prepareLogIcebergRowWrite = vi.fn(
    async (_env: unknown, _adapter: unknown, input: { row: Record<string, unknown> }) => {
      auditRows.push(input.row);
      return { statements: [{ sql: 'AUDIT_STATEMENT', params: [] }], dispatch: auditDispatch };
    }
  );

  async function seed(token: string, value: Record<string, unknown>, expiresIn = 600_000) {
    enrollments.set(await sha256Hex(token), {
      invitation_id: String(value.invitationId),
      phase: String(value.phase),
      state_json: JSON.stringify(value),
      expires_at: Date.now() + expiresIn,
    });
  }

  async function seedRaw(token: string, stateJson: string) {
    enrollments.set(await sha256Hex(token), {
      invitation_id: 'invitation_1',
      phase: 'registration',
      state_json: stateJson,
      expires_at: Date.now() + 600_000,
    });
  }

  function reset() {
    enrollments.clear();
    secondFactors.clear();
    auditRows.length = 0;
    state.invitation = baseInvitation();
    state.namedGroups = [];
    state.missedGroups = [];
    state.updateRowsAffected = null;
  }

  return {
    adapter,
    enrollments,
    secondFactors,
    state,
    webauthn,
    noticeCreate,
    auditDispatch,
    auditRows,
    prepareLogIcebergRowWrite,
    seed,
    seedRaw,
    reset,
  };
}
