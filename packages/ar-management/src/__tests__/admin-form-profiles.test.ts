import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  };
  return { db };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.db })),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
      })),
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
  };
});

import { adminFormProfilesListHandler } from '../admin-form-profiles';

type FormProfileRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  profile_key: string;
  display_name: string;
  form_kind: string;
  fields_json: string;
  settings_json: string | null;
};

const rows: FormProfileRow[] = [];

function createContext() {
  return {
    req: {},
    json: vi.fn((body: unknown, status?: number) => {
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  } as never;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

beforeEach(() => {
  rows.length = 0;
  mocks.db.query.mockReset();
  mocks.db.queryOne.mockReset();
  mocks.db.execute.mockReset();

  mocks.db.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT id FROM form_profiles')) {
      const tenantId = String(params[0]);
      const profileKey = String(params[1]);
      return (
        rows.find((row) => row.tenant_id === tenantId && row.profile_key === profileKey) ?? null
      );
    }
    return null;
  });

  mocks.db.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO form_profiles')) {
      rows.push({
        id: String(params[0]),
        tenant_id: String(params[1]),
        profile_key: String(params[2]),
        display_name: String(params[3]),
        description: params[4],
        form_kind: String(params[5]),
        fields_json: String(params[6]),
        localizations_json: params[7],
        settings_json: typeof params[8] === 'string' ? params[8] : null,
        is_active: params[9],
        is_system: params[10],
        created_at: params[11],
        updated_at: params[12],
      });
    }
    return { success: true };
  });

  mocks.db.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT * FROM form_profiles')) {
      const tenantId = String(params[0]);
      return rows.filter((row) => row.tenant_id === tenantId);
    }
    return [];
  });
});

describe('admin form profiles', () => {
  it('backfills the system consent form profile when listing forms', async () => {
    const response = await adminFormProfilesListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    const consent = profiles.find((profile) => profile.profile_key === 'consent');

    expect(consent).toMatchObject({
      form_kind: 'consent',
      display_name: 'Consent',
      is_system: 1,
    });
    expect(consent?.settings).toEqual({ canvas_layout: 'narrow' });
    expect(rows.map((row) => row.profile_key).sort()).toEqual([
      'consent',
      'login',
      'profile_completion',
      'registration',
    ]);
  });
});
