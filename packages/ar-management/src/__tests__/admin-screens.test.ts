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

import {
  adminScreenCreateHandler,
  adminScreenUpdateHandler,
  adminScreensListHandler,
} from '../admin-screens';

type ScreenRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  screen_key: string;
  display_name: string;
  screen_kind: string;
  fields_json: string;
  settings_json: string | null;
};

const rows: ScreenRow[] = [];
const expectedLocalizationLanguages = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'id',
  'it',
  'ja',
  'ko',
  'pt',
  'ru',
  'th',
  'vi',
  'zh-CN',
  'zh-TW',
];
const expectedDefaultAuthFieldNames = [
  'auth.passkey',
  'divider.or',
  'auth.mail_otp',
  'auth.totp',
  'divider.other_accounts',
  'auth.external_idp',
  'divider.directory_password',
  'auth.directory_password',
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

function createMutationContext(body: Record<string, unknown>, id = 'screen-custom') {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
      param: vi.fn().mockReturnValue(id),
    },
    json: vi.fn(
      (payload: unknown, status?: number) =>
        new Response(JSON.stringify(payload), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
    ),
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
    if (sql.includes('FROM screens') && sql.includes('screen_key')) {
      const tenantId = String(params[0]);
      const screenKey = String(params[1]);
      return rows.find((row) => row.tenant_id === tenantId && row.screen_key === screenKey) ?? null;
    }
    if (sql.includes('FROM screens') && sql.includes('id = ?')) {
      const tenantId = String(params[0]);
      const id = String(params[1]);
      return rows.find((row) => row.tenant_id === tenantId && row.id === id) ?? null;
    }
    return null;
  });

  mocks.db.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO screens')) {
      rows.push({
        id: String(params[0]),
        tenant_id: String(params[1]),
        screen_key: String(params[2]),
        display_name: String(params[3]),
        description: params[4],
        screen_kind: String(params[5]),
        fields_json: String(params[6]),
        localizations_json: params[7],
        settings_json: typeof params[8] === 'string' ? params[8] : null,
        is_active: params[9],
        is_system: params[10],
        created_at: params[11],
        updated_at: params[12],
      });
    }
    if (sql.includes('UPDATE screens')) {
      if (sql.includes('SET screen_kind')) {
        const screenKind = String(params[0]);
        const tenantId = String(params[2]);
        const id = String(params[3]);
        const row = rows.find((item) => item.tenant_id === tenantId && item.id === id);
        if (row) row.screen_kind = screenKind;
      } else if (sql.includes('SET fields_json')) {
        const fieldsJson = String(params[0]);
        const tenantId = String(params[2]);
        const id = String(params[3]);
        const row = rows.find((item) => item.tenant_id === tenantId && item.id === id);
        if (row) row.fields_json = fieldsJson;
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
    if (sql.includes('SELECT * FROM screens')) {
      const tenantId = String(params[0]);
      return rows.filter((row) => row.tenant_id === tenantId);
    }
    return [];
  });
});

describe('admin screens', () => {
  it('rejects unsupported blocks in Account screens', async () => {
    const response = await adminScreenCreateHandler(
      createMutationContext({
        screen_key: 'unsafe_account',
        display_name: 'Unsafe account',
        screen_kind: 'account',
        fields: [
          {
            field: 'auth.passkey',
            label: 'Unexpected auth action',
            required: false,
            block_type: 'auth_widget',
          },
        ],
      })
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: 'invalid_request' });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it('sanitizes localization fields so they cannot replace widget behavior', async () => {
    const response = await adminScreenCreateHandler(
      createMutationContext({
        screen_key: 'localized_account',
        display_name: 'Localized account',
        screen_kind: 'account',
        fields: [
          {
            field: 'account.profile',
            label: 'Profile',
            required: false,
            block_type: 'account_profile_widget',
            block_id: 'profile-widget',
          },
        ],
        localizations: {
          ja: {
            fields: {
              'profile-widget': {
                label: 'プロフィール',
                block_type: 'account_totp_widget',
                href: 'javascript:alert(1)',
              },
            },
          },
          unsupported: { display_name: 'Ignored' },
        },
      })
    );

    expect(response.status).toBe(201);
    const inserted = rows.find((row) => row.screen_key === 'localized_account');
    const localizations = JSON.parse(String(inserted?.localizations_json)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(localizations).toEqual({
      ja: { fields: { 'profile-widget': { label: 'プロフィール' } } },
    });
  });

  it('prevents updates to built-in screens', async () => {
    rows.push({
      id: 'screen-system',
      tenant_id: 'tenant-1',
      screen_key: 'account_profile',
      display_name: 'Profile',
      screen_kind: 'account',
      fields_json: '[]',
      settings_json: '{}',
      is_system: 1,
    });
    const response = await adminScreenUpdateHandler(
      createMutationContext({ display_name: 'Changed' }, 'screen-system')
    );

    expect(response.status).toBe(400);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it('backfills localized system screens when listing screens', async () => {
    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const screens = body.screens as Array<Record<string, unknown>>;
    const consent = screens.find((screen) => screen.screen_key === 'consent');
    const screensByKey = new Map(screens.map((screen) => [screen.screen_key, screen]));

    expect(consent).toMatchObject({
      screen_kind: 'consent',
      display_name: 'Consent',
      is_system: 1,
    });
    expect(consent?.settings).toEqual({ canvas_layout: 'narrow' });
    expect(screensByKey.get('code_input')).toMatchObject({
      screen_kind: 'code_input',
      display_name: 'Code input',
      is_system: 1,
    });
    const overviewFields = screensByKey.get('account_overview')?.fields as Array<
      Record<string, unknown>
    >;
    expect(overviewFields).toHaveLength(1);
    expect(overviewFields[0]).toMatchObject({
      field: 'heading.account_overview',
      label: 'Manage your account',
      required: false,
      block_type: 'heading',
      order: 10,
    });
    expect(overviewFields[0]).not.toHaveProperty('text');
    for (const screenKey of [
      'code_input',
      'consent',
      'login',
      'profile_completion',
      'registration',
    ]) {
      const screen = screensByKey.get(screenKey);
      const localizations = screen?.localizations as Record<string, Record<string, unknown>>;
      expect(Object.keys(localizations).sort()).toEqual(expectedLocalizationLanguages);
      expect(localizations.ja?.display_name).toBeTruthy();
      expect(localizations.en?.display_name).toBeTruthy();
    }
    const registration = screensByKey.get('registration');
    const registrationFields = registration?.fields as Array<Record<string, unknown>>;
    expect(registrationFields.map((field) => field.field)).toEqual([
      'heading.registration',
      'auth.passkey',
      'email',
      ...expectedDefaultAuthFieldNames.slice(1),
    ]);
    const loginFields = screensByKey.get('login')?.fields as Array<Record<string, unknown>>;
    expect(
      registrationFields
        .slice(1)
        .filter((field) => field.block_type !== 'identity_field')
        .map((field) => field.field)
    ).toEqual(loginFields.slice(1).map((field) => field.field));
    expect(registrationFields.find((field) => field.field === 'email')).toMatchObject({
      required: false,
      block_type: 'identity_field',
    });
    expect(
      registrationFields.find((field) => field.field === 'preferred_username')
    ).toBeUndefined();
    expect(registrationFields.find((field) => field.field === 'name')).toBeUndefined();
    expect(registrationFields.find((field) => field.field === 'divider.or')).toMatchObject({
      display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
    });
    expect(
      registrationFields.find((field) => field.field === 'divider.other_accounts')
    ).toMatchObject({
      display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
    });
    expect(
      registrationFields.find((field) => field.field === 'divider.directory_password')
    ).toMatchObject({
      display_condition: { mode: 'feature_enabled', feature: 'directory_password' },
    });
    const registrationJaFields = (
      registration?.localizations as Record<string, Record<string, unknown>>
    ).ja?.fields as Record<string, Record<string, unknown>>;
    expect(registrationJaFields?.['heading.registration-0']?.label).toBe('アカウントを作成');
    expect(registrationJaFields?.['auth.passkey-1']?.label).toBe('Passkeyでアカウント作成');
    expect(registrationJaFields?.['email-2']?.label).toBe('メールアドレス');
    expect(registrationJaFields?.['auth.mail_otp-4']?.label).toBe('認証コードをメール送信');
    expect(registrationJaFields?.['auth.totp-5']?.label).toBe('認証アプリで新規登録');
    const loginJaFields = (
      screensByKey.get('login')?.localizations as Record<string, Record<string, unknown>>
    ).ja?.fields as Record<string, Record<string, unknown>>;
    expect(loginJaFields?.['heading.login-0']?.label).toBe('ログイン');
    expect(loginJaFields?.['auth.passkey-1']?.label).toBe('Passkeyでサインイン');
    const loginZhCn = (
      screensByKey.get('login')?.localizations as Record<string, Record<string, unknown>>
    )['zh-CN']?.fields as Record<string, Record<string, unknown>>;
    expect(loginZhCn?.['auth.mail_otp-3']?.label).toBe('通过电子邮件发送验证码');
    expect(loginZhCn?.['auth.totp-4']?.label).toBe('使用身份验证器应用登录');
    expect(loginZhCn?.['auth.external_idp-6']?.label).toBe('Ext. IdP');
    expect(loginZhCn?.['divider.directory_password-7']?.label).toBe('或');
    const loginAr = (
      screensByKey.get('login')?.localizations as Record<string, Record<string, unknown>>
    ).ar?.fields as Record<string, Record<string, unknown>>;
    expect(loginAr?.['heading.login-0']?.label).toBe('تسجيل الدخول');
    expect(loginAr?.['auth.passkey-1']?.label).toBe('تسجيل الدخول باستخدام مفتاح المرور');
    expect(loginAr?.['divider.directory_password-7']?.label).toBe('أو');
    const codeInputZhCn = (
      screensByKey.get('code_input')?.localizations as Record<string, Record<string, unknown>>
    )['zh-CN']?.fields as Record<string, Record<string, unknown>>;
    expect(codeInputZhCn?.['heading.code_input-0']?.label).toBe('输入验证码');
    expect(codeInputZhCn?.['auth.code_input-1']?.label).toBe('验证码');
    expect(codeInputZhCn?.['auth.code_input-1']?.text).toBe(
      '请输入电子邮件或身份验证器应用中的验证码。'
    );
    expect(rows.map((row) => row.screen_key).sort()).toEqual([
      'account_activity',
      'account_consents',
      'account_custom',
      'account_devices',
      'account_overview',
      'account_passkeys',
      'account_profile',
      'account_sessions',
      'account_social_accounts',
      'account_totp',
      'code_input',
      'consent',
      'login',
      'profile_completion',
      'registration',
    ]);
  });

  it('removes the retired account overview description and security link from existing defaults', async () => {
    rows.push({
      id: 'screen-account-overview-default',
      tenant_id: 'tenant-1',
      screen_key: 'account_overview',
      display_name: 'Account overview',
      description: 'Account page introduction and safe navigation guidance.',
      screen_kind: 'account',
      fields_json: JSON.stringify([
        {
          field: 'heading.account_overview',
          label: 'Manage your account',
          required: false,
          block_type: 'heading',
          text: 'Review your profile, sign-in methods, sessions, and consent information.',
          order: 10,
        },
        {
          field: 'link.account_security',
          label: 'Review security settings',
          required: false,
          block_type: 'link',
          href: '#profile',
          order: 20,
        },
      ]),
      localizations_json: JSON.stringify({
        ja: {
          fields: {
            'heading.account_overview-0': {
              label: 'アカウントを管理',
              text: 'Review your profile, sign-in methods, sessions, and consent information.',
            },
            'link.account_security-1': { label: 'セキュリティ設定を確認' },
          },
        },
      }),
      settings_json: JSON.stringify({ canvas_layout: 'wide' }),
      is_active: 1,
      is_system: 1,
    });

    const response = await adminScreensListHandler(createContext());
    const body = await readJson(response);
    const overview = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'account_overview'
    );
    const fields = overview?.fields as Array<Record<string, unknown>>;
    const jaFields = (overview?.localizations as Record<string, Record<string, unknown>>).ja
      ?.fields as Record<string, Record<string, unknown>>;

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      field: 'heading.account_overview',
      label: 'Manage your account',
    });
    expect(fields[0]).not.toHaveProperty('text');
    expect(jaFields['heading.account_overview-0']).toEqual({ label: 'アカウントを管理' });
    expect(jaFields).not.toHaveProperty('link.account_security-1');
  });

  it('preserves email and name fields added to the registration system screen', async () => {
    rows.push({
      id: 'screen-registration-default',
      tenant_id: 'tenant-1',
      screen_key: 'registration',
      display_name: 'Registration',
      description: 'Default registration screen.',
      screen_kind: 'registration',
      fields_json: JSON.stringify([
        {
          field: 'heading.registration',
          label: 'Create your account',
          required: false,
          block_type: 'heading',
          block_id: 'heading-registration',
          order: 0,
        },
        {
          field: 'email',
          label: 'Email',
          required: true,
          block_type: 'identity_field',
          block_id: 'identity-email',
          order: 10,
        },
        {
          field: 'name',
          label: 'Name',
          required: false,
          block_type: 'identity_field',
          block_id: 'identity-name',
          order: 20,
        },
        {
          field: 'auth.passkey',
          label: 'Create Account with Passkey',
          required: false,
          block_type: 'auth_widget',
          block_id: 'auth-passkey',
          auth_method: 'passkey',
          order: 30,
        },
      ]),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const registration = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'registration'
    );
    const fields = registration?.fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.field)).toEqual([
      'heading.registration',
      'email',
      'name',
      'divider.or',
      'auth.passkey',
      'auth.mail_otp',
      'auth.totp',
      'divider.other_accounts',
      'auth.external_idp',
      'divider.directory_password',
      'auth.directory_password',
    ]);
  });

  it('replaces the name field in the previous uncustomized registration default', async () => {
    const previousDefaultFields = [
      ['heading.registration', 'heading', 0],
      ['auth.passkey', 'auth_widget', 10],
      ['email', 'identity_field', 15],
      ['name', 'identity_field', 17],
      ['divider.or', 'divider', 20],
      ['auth.mail_otp', 'auth_widget', 30],
      ['auth.totp', 'auth_widget', 35],
      ['divider.other_accounts', 'divider', 40],
      ['auth.external_idp', 'auth_widget', 50],
      ['divider.directory_password', 'divider', 55],
      ['auth.directory_password', 'auth_widget', 60],
    ].map(([field, blockType, order]) => ({
      field,
      label: field,
      required: field === 'email',
      block_type: blockType,
      order,
    }));
    rows.push({
      id: 'screen-registration-default',
      tenant_id: 'tenant-1',
      screen_key: 'registration',
      display_name: 'Registration',
      description: 'Default registration screen.',
      screen_kind: 'registration',
      fields_json: JSON.stringify(previousDefaultFields),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const registration = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'registration'
    );
    const fields = registration?.fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.field)).toEqual([
      'heading.registration',
      'auth.passkey',
      'email',
      ...expectedDefaultAuthFieldNames.slice(1),
    ]);
  });

  it('keeps the email-only uncustomized registration default', async () => {
    const emailOnlyDefaultFields = [
      ['heading.registration', 'heading', 0],
      ['auth.passkey', 'auth_widget', 10],
      ['email', 'identity_field', 15],
      ['divider.or', 'divider', 20],
      ['auth.mail_otp', 'auth_widget', 30],
      ['auth.totp', 'auth_widget', 35],
      ['divider.other_accounts', 'divider', 40],
      ['auth.external_idp', 'auth_widget', 50],
      ['divider.directory_password', 'divider', 55],
      ['auth.directory_password', 'auth_widget', 60],
    ].map(([field, blockType, order]) => ({
      field,
      label: field,
      required: field === 'email',
      block_type: blockType,
      order,
    }));
    rows.push({
      id: 'screen-registration-default',
      tenant_id: 'tenant-1',
      screen_key: 'registration',
      display_name: 'Registration',
      description: 'Default registration screen.',
      screen_kind: 'registration',
      fields_json: JSON.stringify(emailOnlyDefaultFields),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const registration = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'registration'
    );
    const fields = registration?.fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.field)).toEqual([
      'heading.registration',
      'auth.passkey',
      'email',
      ...expectedDefaultAuthFieldNames.slice(1),
    ]);
  });

  it('removes preferred username from the uncustomized registration default', async () => {
    const usernameDefaultFields = [
      ['heading.registration', 'heading', 0],
      ['auth.passkey', 'auth_widget', 10],
      ['email', 'identity_field', 15],
      ['preferred_username', 'identity_field', 17],
      ['divider.or', 'divider', 20],
      ['auth.mail_otp', 'auth_widget', 30],
      ['auth.totp', 'auth_widget', 35],
      ['divider.other_accounts', 'divider', 40],
      ['auth.external_idp', 'auth_widget', 50],
      ['divider.directory_password', 'divider', 55],
      ['auth.directory_password', 'auth_widget', 60],
    ].map(([field, blockType, order]) => ({
      field,
      label: field,
      required: field === 'email',
      block_type: blockType,
      order,
    }));
    rows.push({
      id: 'screen-registration-default',
      tenant_id: 'tenant-1',
      screen_key: 'registration',
      display_name: 'Registration',
      description: 'Default registration screen.',
      screen_kind: 'registration',
      fields_json: JSON.stringify(usernameDefaultFields),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const registration = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'registration'
    );
    const fields = registration?.fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.field)).toEqual([
      'heading.registration',
      'auth.passkey',
      'email',
      ...expectedDefaultAuthFieldNames.slice(1),
    ]);
  });

  it('migrates only the exact legacy registration default fields', async () => {
    rows.push({
      id: 'screen-registration-default',
      tenant_id: 'tenant-1',
      screen_key: 'registration',
      display_name: 'Registration',
      description: 'Default registration screen.',
      screen_kind: 'registration',
      fields_json: JSON.stringify([
        {
          field: 'auth.passkey',
          label: 'Create Account with Passkey',
          required: false,
          block_type: 'auth_widget',
          auth_method: 'passkey',
          order: 10,
        },
        {
          field: 'auth.totp',
          label: 'Create account with authenticator app',
          required: false,
          block_type: 'auth_widget',
          auth_method: 'totp',
          order: 15,
        },
        {
          field: 'email',
          label: 'Email',
          required: true,
          block_type: 'identity_field',
          order: 20,
        },
        {
          field: 'name',
          label: 'Name',
          required: false,
          block_type: 'identity_field',
          order: 30,
        },
      ]),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const registration = (body.screens as Array<Record<string, unknown>>).find(
      (screen) => screen.screen_key === 'registration'
    );
    const fields = registration?.fields as Array<Record<string, unknown>>;
    expect(fields.map((field) => field.field)).toEqual([
      'heading.registration',
      'auth.passkey',
      'email',
      ...expectedDefaultAuthFieldNames.slice(1),
    ]);
  });

  it('migrates the code input system screen to the dedicated screen kind', async () => {
    rows.push({
      id: 'screen-code-input-default',
      tenant_id: 'tenant-1',
      screen_key: 'code_input',
      display_name: 'Code input',
      description: 'Default code input screen.',
      screen_kind: 'custom',
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

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const screens = body.screens as Array<Record<string, unknown>>;
    expect(screens.find((screen) => screen.screen_key === 'code_input')).toMatchObject({
      screen_kind: 'code_input',
    });
    const codeInput = screens.find((screen) => screen.screen_key === 'code_input');
    expect(
      (codeInput?.fields as Array<Record<string, unknown>>).map((field) => field.field)
    ).toEqual(['heading.code_input', 'auth.code_input']);
  });

  it('backfills default login divider display conditions', async () => {
    rows.push({
      id: 'screen-login-default',
      tenant_id: 'tenant-1',
      screen_key: 'login',
      display_name: 'Login',
      description: 'Default login screen.',
      screen_kind: 'login',
      fields_json: JSON.stringify([
        {
          field: 'auth.passkey',
          label: 'Sign in with Passkey',
          required: false,
          block_type: 'auth_widget',
          auth_method: 'passkey',
          order: 10,
        },
        {
          field: 'divider.or',
          label: 'or',
          required: false,
          block_type: 'divider',
          text: 'or',
          order: 20,
        },
        {
          field: 'divider.other_accounts',
          label: 'Continue with another account',
          required: false,
          block_type: 'divider',
          text: 'Continue with another account',
          order: 40,
        },
      ]),
      localizations_json: '{}',
      settings_json: '{"canvas_layout":"narrow"}',
      is_active: 1,
      is_system: 1,
      created_at: 0,
      updated_at: 0,
    });

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const screens = body.screens as Array<Record<string, unknown>>;
    const login = screens.find((screen) => screen.screen_key === 'login');
    const fields = login?.fields as Array<Record<string, unknown>>;
    expect(fields.find((field) => field.field === 'divider.or')).toMatchObject({
      display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
    });
    expect(fields.find((field) => field.field === 'divider.other_accounts')).toMatchObject({
      display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
    });
  });

  it('replaces default English strings in existing system screen localizations', async () => {
    rows.push({
      id: 'screen-login-default',
      tenant_id: 'tenant-1',
      screen_key: 'login',
      display_name: 'Login',
      description: 'Default login screen.',
      screen_kind: 'login',
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
        'zh-CN': {
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

    const response = await adminScreensListHandler(createContext());
    expect(response.status).toBe(200);

    const body = await readJson(response);
    const screens = body.screens as Array<Record<string, unknown>>;
    const login = screens.find((screen) => screen.screen_key === 'login');
    const ja = (login?.localizations as Record<string, Record<string, unknown>>).ja;
    expect(ja.display_name).toBe('ログイン');
    expect((ja.fields as Record<string, Record<string, unknown>>)['auth.passkey-1'].label).toBe(
      'Passkeyでサインイン'
    );
    const zhCn = (login?.localizations as Record<string, Record<string, unknown>>)['zh-CN'];
    expect(zhCn.display_name).toBe('登录');
    expect((zhCn.fields as Record<string, Record<string, unknown>>)['auth.passkey-1'].label).toBe(
      '使用 Passkey 登录'
    );
  });
});
