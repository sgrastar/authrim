/**
 * The lite account page's composition (account-page.ts): the SPA's rules for which placements
 * show, their blocks' order and words, link targets and widget titles.
 */
import { describe, expect, it } from 'vitest';
import {
	liteAccountHref,
	liteAccountPageWords,
	liteAccountPlacementVisible,
	liteAccountScreenFields,
	liteAccountWidgetTitle,
	readLiteAccountPage,
	type LiteAccountConditions
} from '../account-page';

const conditions = (over: Partial<LiteAccountConditions> = {}): LiteAccountConditions => ({
	registrationState: 'registered',
	passkeyEnabled: true,
	totpManagementEnabled: true,
	externalIdpEnabled: true,
	consentRecordsAvailable: true,
	multipleSessions: true,
	...over
});

describe('the lite account page composition', () => {
	it('reads the placements in their order, with defaults for what they leave out', () => {
		const page = readLiteAccountPage({
			account_page: {
				definition: {
					title: 'Mine',
					screens: [
						{ id: 'b', screen_key: 'account_sessions', width: 'half', condition: 'nope' },
						{ id: 'a', screen_key: 'account_profile', enabled: false, show_for_guests: false },
						{ id: 'bad id!', screen_key: 'x' }
					]
				},
				screens: []
			}
		});
		expect(page?.title).toBe('Mine');
		expect(page?.placements).toEqual([
			{
				id: 'b',
				screenKey: 'account_sessions',
				width: 'half',
				enabled: true,
				condition: 'always',
				showForGuests: true
			},
			{
				id: 'a',
				screenKey: 'account_profile',
				width: 'full',
				enabled: false,
				condition: 'always',
				showForGuests: false
			}
		]);
		expect(readLiteAccountPage({})).toBeNull();
	});

	it('shows a placement by its switch, the guest gate and its condition', () => {
		const placement = {
			id: 'p',
			screenKey: 'k',
			width: 'full' as const,
			enabled: true,
			condition: 'passkey_enabled' as const,
			showForGuests: false
		};
		expect(liteAccountPlacementVisible(placement, conditions())).toBe(true);
		expect(liteAccountPlacementVisible(placement, conditions({ passkeyEnabled: false }))).toBe(
			false
		);
		// A guest (or a person whose state is not known) sees none kept from guests.
		expect(liteAccountPlacementVisible(placement, conditions({ registrationState: 'guest' }))).toBe(
			false
		);
		expect(liteAccountPlacementVisible(placement, conditions({ registrationState: null }))).toBe(
			false
		);
		expect(liteAccountPlacementVisible({ ...placement, enabled: false }, conditions())).toBe(false);
		expect(
			liteAccountPlacementVisible(
				{ ...placement, condition: 'hidden', showForGuests: true },
				conditions()
			)
		).toBe(false);
		expect(
			liteAccountPlacementVisible(
				{ ...placement, condition: 'multiple_sessions', showForGuests: true },
				conditions({ multipleSessions: false })
			)
		).toBe(false);
	});

	it('orders the fields and takes the locale words by block id or field and index', () => {
		const fields = liteAccountScreenFields(
			{
				screenKey: 'account_overview',
				fields: [
					{
						field: 'heading.account_overview',
						label: 'Manage',
						blockType: 'heading',
						blockId: null,
						text: 'subtitle',
						href: null,
						order: 10,
						layoutColumn: null
					},
					{
						field: 'account.upgrade',
						label: 'Register',
						blockType: 'account_upgrade_widget',
						blockId: 'up',
						text: null,
						href: null,
						order: 5,
						layoutColumn: null
					},
					{
						field: 'link.account_security',
						label: 'Security',
						blockType: 'link',
						blockId: null,
						text: null,
						href: '#x',
						order: 20,
						layoutColumn: null
					}
				],
				localizations: {
					ja: {
						fields: { up: { label: '登録' }, 'heading.account_overview-1': { label: '管理' } }
					},
					en: { fields: { up: { label: 'Sign up' } } }
				}
			},
			'ja-JP',
			'en'
		);
		expect(fields.map((field) => [field.field, field.label, field.text])).toEqual([
			['account.upgrade', '登録', null],
			// The overview's heading has no subtitle; its security link is left out.
			['heading.account_overview', '管理', null]
		]);
	});

	it('draws a link only to a placement shown, a path of this origin, or https', () => {
		const shown = (id: string) => id === 'profile';
		expect(liteAccountHref('#profile', shown)).toBe('#profile');
		expect(liteAccountHref('#hidden', shown)).toBeNull();
		expect(liteAccountHref('/account/x', shown)).toBe('/account/x');
		expect(liteAccountHref('//evil.example', shown)).toBeNull();
		expect(liteAccountHref('/\\evil.example', shown)).toBeNull();
		expect(liteAccountHref('https://example.com/a', shown)).toBe('https://example.com/a');
		expect(liteAccountHref('http://example.com', shown)).toBeNull();
		expect(liteAccountHref('javascript:alert(1)', shown)).toBeNull();
	});

	it('titles a widget by its own label, else (unset, a seed label, a system block) the default', () => {
		const field = {
			field: 'account.profile',
			label: 'User profile',
			blockType: 'account_profile_widget',
			blockId: null,
			text: null,
			href: null,
			order: 0,
			layoutColumn: null
		};
		expect(liteAccountWidgetTitle(field, 'プロフィール')).toBe('プロフィール');
		expect(liteAccountWidgetTitle({ ...field, label: 'Mine', blockId: 'b' }, 'D')).toBe('Mine');
		expect(liteAccountWidgetTitle({ ...field, label: 'Mine' }, 'D')).toBe('D');
		expect(liteAccountWidgetTitle({ ...field, label: '', blockId: 'b' }, 'D')).toBe('D');
	});

	it("takes the page's title and description in its locale, else the default's, else its own", () => {
		const page = readLiteAccountPage({
			account_page: {
				definition: {
					title: 'Own',
					description: 'Own words',
					localizations: { fr: { title: 'Le mien' } },
					screens: []
				},
				screens: []
			}
		})!;
		expect(liteAccountPageWords(page, 'fr-FR', 'en', null)).toEqual({
			title: 'Le mien',
			description: 'Own words'
		});
		expect(liteAccountPageWords(page, 'de', 'en', null).title).toBe('Own');
	});
});
