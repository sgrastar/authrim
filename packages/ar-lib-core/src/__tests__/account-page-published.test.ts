import { describe, expect, it } from 'vitest';
import {
  passkeyPlacementId,
  publishedAccountPageFromSettings,
} from '../utils/account-page-published';

function settingsWithPage(screens: unknown[], snapshots: Record<string, unknown>) {
  return {
    'login-ui.account_pages': JSON.stringify({
      schema_version: 'authrim.account_pages.v1',
      default_page_id: 'p1',
      pages: [
        {
          id: 'p1',
          name: 'Page',
          published_version: 2,
          published_at: '2026-11-08T00:00:00.000Z',
          published: {
            schema_version: 'authrim.account_page.v1',
            resolved_at: '2026-11-08T00:00:00.000Z',
            screens,
            screen_snapshots: snapshots,
          },
        },
      ],
    }),
  };
}

const placement = (id: string, screenKey: string, extra: Record<string, unknown> = {}) => ({
  id,
  screen_key: screenKey,
  width: 'full',
  enabled: true,
  condition: 'always',
  show_for_guests: true,
  ...extra,
});

const snapshot = (screenKey: string, blockType: string) => ({
  screen_kind: 'account',
  screen_key: screenKey,
  fields: [{ block_type: blockType, field: 'widget', label: 'Widget' }],
  localizations: {},
});

describe('passkeyPlacementId', () => {
  it('finds the built-in passkeys placement on the default page', () => {
    expect(passkeyPlacementId(publishedAccountPageFromSettings(null))).toBe('passkeys');
  });

  it('finds the placement whose snapshot carries the passkey widget', () => {
    const page = publishedAccountPageFromSettings(
      settingsWithPage([placement('profile', 'custom_profile'), placement('keys', 'custom_keys')], {
        custom_profile: snapshot('custom_profile', 'account_profile_widget'),
        custom_keys: snapshot('custom_keys', 'account_passkey_widget'),
      })
    );
    expect(page.page_id).toBe('p1');
    expect(passkeyPlacementId(page)).toBe('keys');
  });

  it('does not count a builder page placement by its screen key alone', () => {
    const page = publishedAccountPageFromSettings(
      settingsWithPage([placement('passkeys', 'account_passkeys')], {
        account_passkeys: snapshot('account_passkeys', 'account_profile_widget'),
      })
    );
    expect(passkeyPlacementId(page)).toBeNull();
  });

  it.each([{ enabled: false }, { condition: 'hidden' }, { condition: 'totp_enabled' }])(
    'skips a passkey placement that is not shown to everyone (%o)',
    (extra) => {
      const page = publishedAccountPageFromSettings(
        settingsWithPage([placement('keys', 'custom_keys', extra)], {
          custom_keys: snapshot('custom_keys', 'account_passkey_widget'),
        })
      );
      expect(passkeyPlacementId(page)).toBeNull();
    }
  );

  it('skips a placement hidden from guests and takes a later one shown to everyone', () => {
    const builder = (screens: unknown[]) =>
      publishedAccountPageFromSettings(
        settingsWithPage(screens, {
          members_keys: snapshot('members_keys', 'account_passkey_widget'),
          all_keys: snapshot('all_keys', 'account_passkey_widget'),
        })
      );
    expect(
      passkeyPlacementId(
        builder([placement('members', 'members_keys', { show_for_guests: false })])
      )
    ).toBeNull();
    expect(
      passkeyPlacementId(
        builder([
          placement('members', 'members_keys', { show_for_guests: false }),
          placement('everyone', 'all_keys'),
        ])
      )
    ).toBe('everyone');

    const legacy = publishedAccountPageFromSettings({
      'login-ui.account_page_published': JSON.stringify({
        screens: [placement('members', 'account_passkeys', { show_for_guests: false })],
      }),
    });
    expect(passkeyPlacementId(legacy)).toBeNull();

    const legacyWithFallback = publishedAccountPageFromSettings({
      'login-ui.account_page_published': JSON.stringify({
        screens: [
          placement('members', 'account_passkeys', { show_for_guests: false }),
          placement('everyone', 'account_passkeys'),
        ],
      }),
    });
    expect(passkeyPlacementId(legacyWithFallback)).toBe('everyone');
  });

  it('counts the built-in passkeys screen on a legacy page and honours its condition', () => {
    const legacy = (screens: unknown[]) =>
      publishedAccountPageFromSettings({
        'login-ui.account_page_published': JSON.stringify({ screens }),
      });
    expect(
      passkeyPlacementId(
        legacy([placement('mine', 'account_passkeys', { condition: 'passkey_enabled' })])
      )
    ).toBe('mine');
    expect(passkeyPlacementId(legacy([placement('profile', 'account_profile')]))).toBeNull();
  });
});
