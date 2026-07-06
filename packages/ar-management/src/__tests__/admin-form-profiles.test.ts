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
const expectedLocalizationLanguages = [
  'de',
  'en',
  'es',
  'fr',
  'id',
  'ja',
  'ko',
  'pt',
  'ru',
  'zh_CN',
  'zh_TW',
];

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
    if (sql.includes('FROM form_profiles') && sql.includes('profile_key')) {
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
    if (sql.includes('UPDATE form_profiles')) {
      if (sql.includes('SET form_kind')) {
        const formKind = String(params[0]);
        const tenantId = String(params[2]);
        const id = String(params[3]);
        const row = rows.find((item) => item.tenant_id === tenantId && item.id === id);
        if (row) row.form_kind = formKind;
      } else {
        const localizationsJson = String(params[0]);
        const tenantId = String(params[2]);
        const id = String(params[3]);
        const row = rows.find((item) => item.tenant_id === tenantId && item.id === id);
        if (row) row.localizations_json = localizationsJson;
      }
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
  it('backfills localized system form profiles when listing forms', async () => {
    const response = await adminFormProfilesListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    const consent = profiles.find((profile) => profile.profile_key === 'consent');
    const profilesByKey = new Map(profiles.map((profile) => [profile.profile_key, profile]));

    expect(consent).toMatchObject({
      form_kind: 'consent',
      display_name: 'Consent',
      is_system: 1,
    });
    expect(consent?.settings).toEqual({ canvas_layout: 'narrow' });
    expect(profilesByKey.get('code_input')).toMatchObject({
      form_kind: 'code_input',
      display_name: 'Code input',
      is_system: 1,
    });
    for (const profileKey of [
      'code_input',
      'consent',
      'login',
      'profile_completion',
      'registration',
    ]) {
      const profile = profilesByKey.get(profileKey);
      const localizations = profile?.localizations as Record<string, Record<string, unknown>>;
      expect(Object.keys(localizations).sort()).toEqual(expectedLocalizationLanguages);
      expect(localizations.ja?.display_name).toBeTruthy();
      expect(localizations.en?.display_name).toBeTruthy();
    }
    expect(
      (
        (
          profilesByKey.get('registration')?.localizations as Record<
            string,
            Record<string, unknown>
          >
        ).ja?.fields as Record<string, Record<string, unknown>>
      )?.['auth.passkey-0']?.label
    ).toBe('Passkeyでアカウント作成');
    expect(
      (
        (profilesByKey.get('login')?.localizations as Record<string, Record<string, unknown>>).ja
          ?.fields as Record<string, Record<string, unknown>>
      )?.['auth.passkey-0']?.label
    ).toBe('Passkeyでサインイン');
    const loginZhCn = (
      profilesByKey.get('login')?.localizations as Record<string, Record<string, unknown>>
    ).zh_CN?.fields as Record<string, Record<string, unknown>>;
    expect(loginZhCn?.['auth.mail_otp-2']?.label).toBe('通过电子邮件发送验证码');
    expect(loginZhCn?.['auth.totp-3']?.label).toBe('使用身份验证器应用登录');
    expect(loginZhCn?.['auth.external_idp-5']?.label).toBe('Ext. IdP');
    const codeInputZhCn = (
      profilesByKey.get('code_input')?.localizations as Record<string, Record<string, unknown>>
    ).zh_CN?.fields as Record<string, Record<string, unknown>>;
    expect(codeInputZhCn?.['auth.code_input-0']?.label).toBe('验证码');
    expect(codeInputZhCn?.['auth.code_input-0']?.text).toBe(
      '请输入电子邮件或身份验证器应用中的验证码。'
    );
    expect(rows.map((row) => row.profile_key).sort()).toEqual([
      'code_input',
      'consent',
      'login',
      'profile_completion',
      'registration',
    ]);
  });

  it('migrates the code input system profile to the dedicated form kind', async () => {
    rows.push({
      id: 'form-code-input-default',
      tenant_id: 'tenant-1',
      profile_key: 'code_input',
      display_name: 'Code input',
      description: 'Default code input form.',
      form_kind: 'custom',
      fields_json: JSON.stringify([
        {
          field: 'auth.code_input',
          label: 'Authentication code',
          required: true,
          block_type: 'code_input_widget',
          code_input_mode: 'auto',
          order: 10,
        },
      ]),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminFormProfilesListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    expect(profiles.find((profile) => profile.profile_key === 'code_input')).toMatchObject({
      form_kind: 'code_input',
    });
  });

  it('replaces default English strings in existing system profile localizations', async () => {
    rows.push({
      id: 'form-login-default',
      tenant_id: 'tenant-1',
      profile_key: 'login',
      display_name: 'Login',
      description: 'Default login form.',
      form_kind: 'login',
      fields_json: JSON.stringify([
        {
          field: 'auth.passkey',
          label: 'Sign in with Passkey',
          required: false,
          block_type: 'auth_widget',
          auth_method: 'passkey',
          order: 10,
        },
      ]),
      localizations_json: JSON.stringify({
        ja: {
          display_name: 'Login',
          fields: {
            'auth.passkey-0': {
              label: 'Sign in with Passkey',
            },
          },
        },
        zh_CN: {
          display_name: 'Login',
          fields: {
            'auth.passkey-0': {
              label: 'Passkeyでサインイン',
            },
          },
        },
      }),
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminFormProfilesListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    const login = profiles.find((profile) => profile.profile_key === 'login');
    const ja = (login?.localizations as Record<string, Record<string, unknown>>).ja;
    expect(ja.display_name).toBe('ログイン');
    expect((ja.fields as Record<string, Record<string, unknown>>)['auth.passkey-0'].label).toBe(
      'Passkeyでサインイン'
    );
    const zhCn = (login?.localizations as Record<string, Record<string, unknown>>).zh_CN;
    expect(zhCn.display_name).toBe('登录');
    expect((zhCn.fields as Record<string, Record<string, unknown>>)['auth.passkey-0'].label).toBe(
      '使用 Passkey 登录'
    );
  });
});
