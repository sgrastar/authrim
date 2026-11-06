import { describe, expect, it } from 'vitest';
import type { ScreenField } from '../../types/screens';
import {
  liteAccountScreenIssues,
  liteFlowComponentIssues,
  liteScreenIssues,
  normalizeLiteModeIssues,
} from '../lite-compatibility';
import { isLoginUILiteSelectable, LOGIN_UI_LITE_RELEASED } from '../../types/login-ui-lite';

const field = (overrides: Partial<ScreenField>): ScreenField => ({
  field: 'f',
  label: 'F',
  required: false,
  ...overrides,
});

const ON = new Set(['passkey', 'mail_otp', 'totp', 'external_idp']);

describe('liteScreenIssues', () => {
  it('accepts the blocks and methods the lite UI renders', () => {
    expect(
      liteScreenIssues(
        'login',
        [
          field({ block_type: 'heading' }),
          field({}), // a field without a block type is an identity field
          field({ block_type: 'auth_widget', auth_method: 'passkey' }),
          field({ block_type: 'auth_widget', auth_method: 'mail_otp' }),
          field({ block_type: 'auth_widget', auth_method: 'external_idp' }),
          field({ block_type: 'guest_login_widget' }),
          field({ block_type: 'security_verification' }),
        ],
        ON
      )
    ).toEqual([]);
  });

  it('allows a block for a method that is off, and refuses it when the method is on', () => {
    const password = field({ block_type: 'auth_widget', auth_method: 'directory_password' });
    expect(liteScreenIssues('login', [password], ON)).toEqual([]);
    expect(liteScreenIssues('login', [password], new Set([...ON, 'directory_password']))).toEqual([
      { code: 'screen_method_unsupported', subject: 'login', detail: 'directory_password' },
    ]);
  });

  it('refuses an unknown method and a widget that names none', () => {
    expect(
      liteScreenIssues(
        'login',
        [field({ block_type: 'auth_widget', auth_method: '' })],
        new Set([...ON, 'sms'])
      )
    ).toEqual([{ code: 'screen_method_unsupported', subject: 'login', detail: 'none' }]);
    expect(
      liteScreenIssues(
        'login',
        [field({ block_type: 'auth_widget', auth_method: 'sms' })],
        new Set([...ON, 'sms'])
      )
    ).toEqual([{ code: 'screen_method_unsupported', subject: 'login', detail: 'sms' }]);
  });

  it('refuses the choice and checkbox parts until the lite UI draws them', () => {
    expect(
      liteScreenIssues(
        'profile',
        [
          field({ block_type: 'select' }),
          field({ block_type: 'radio' }),
          field({ block_type: 'checkbox' }),
        ],
        ON
      ).map((issue) => issue.detail)
    ).toEqual(['select', 'radio', 'checkbox']);
  });

  it('refuses a block type it does not know, unless the block is hidden', () => {
    expect(
      liteScreenIssues('profile', [field({ block_type: 'account_profile_widget' })], ON)
    ).toEqual([
      { code: 'screen_block_unsupported', subject: 'profile', detail: 'account_profile_widget' },
    ]);
    expect(
      liteScreenIssues(
        'profile',
        [
          field({ block_type: 'account_profile_widget', display_condition: { mode: 'hidden' } }),
          field({
            block_type: 'auth_widget',
            auth_method: 'directory_password',
            display_condition: { mode: 'feature_enabled', feature: 'directory_password' },
          }),
        ],
        ON
      )
    ).toEqual([]);
  });
});

describe('liteAccountScreenIssues', () => {
  it('accepts the account widgets and refuses sign-in widgets', () => {
    expect(
      liteAccountScreenIssues('account_security', [
        field({ block_type: 'account_passkey_widget' }),
        field({ block_type: 'account_totp_widget' }),
        field({ block_type: 'heading' }),
      ])
    ).toEqual([]);
    expect(
      liteAccountScreenIssues('account_security', [field({ block_type: 'auth_widget' })])
    ).toEqual([
      { code: 'account_block_unsupported', subject: 'account_security', detail: 'auth_widget' },
    ]);
  });
});

describe('liteFlowComponentIssues', () => {
  it('names each unsupported component once', () => {
    expect(
      liteFlowComponentIssues('flow-1', [
        { component: 'interaction_context' },
        { component: 'authentication_method_selector' },
        { component: 'credential_offer' },
        { component: 'credential_offer' },
        { component: 'custom:risk' },
        { component: 42 },
      ])
    ).toEqual([
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'credential_offer' },
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'custom:risk' },
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'unknown' },
    ]);
  });
});

describe('normalizeLiteModeIssues', () => {
  it('drops duplicates and sorts', () => {
    expect(
      normalizeLiteModeIssues([
        { code: 'method_unsupported', subject: 'did' },
        { code: 'client_login_ui_url', subject: 'app' },
        { code: 'method_unsupported', subject: 'did' },
      ])
    ).toEqual([
      { code: 'client_login_ui_url', subject: 'app' },
      { code: 'method_unsupported', subject: 'did' },
    ]);
  });
});

describe('isLoginUILiteSelectable', () => {
  it('is locked until release unless pre-release is allowed', () => {
    expect(LOGIN_UI_LITE_RELEASED).toBe(false);
    expect(isLoginUILiteSelectable({})).toBe(false);
    expect(isLoginUILiteSelectable({ LOGIN_UI_LITE_PRERELEASE: 'true' })).toBe(false);
    expect(isLoginUILiteSelectable({ LOGIN_UI_LITE_PRERELEASE: 'allow' })).toBe(true);
    expect(isLoginUILiteSelectable({}, true)).toBe(true);
  });
});
