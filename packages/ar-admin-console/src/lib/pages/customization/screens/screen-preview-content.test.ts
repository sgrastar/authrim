import { describe, expect, it } from 'vitest';
import type { ScreenListItem } from '#lib/api/screens.js';
import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
import {
	localizedScreenPreview,
	savedScreenPreview,
	themeScreenPreviews
} from './screen-preview-content';

const listed = (index: number): ScreenListItem => ({
	...structuredClone(MOCK_SCREENS[index]),
	usage: { flows: 0, account_pages: 0 }
});

describe('saved screen previews', () => {
	it('offers registration, login, then profile completion and omits other kinds', () => {
		const signIn = listed(0);
		const signUp = listed(1);
		const survey = listed(2);
		const profile = {
			...listed(2),
			id: 'screen_profile',
			screen_kind: 'profile_completion' as const
		};
		const anotherSignUp = { ...listed(1), id: 'screen_signup_copy' };
		expect(
			themeScreenPreviews([signIn, survey, signUp, profile, anotherSignUp]).map(
				(screen) => screen.id
			)
		).toEqual(['screen_signup', 'screen_signup_copy', 'screen_login', 'screen_profile']);
	});

	it('uses the saved parts and keeps implicit parts in separate rows', () => {
		const preview = savedScreenPreview(listed(0));
		expect(preview.rows.map((row) => row.columns.flat().map((part) => part.label))).toEqual([
			['Sign in'],
			['Sign in with Passkey'],
			['or'],
			['Email code']
		]);
		expect(preview.canvas).toBe('narrow');
	});

	it('shows screen and part translations without changing the saved source', () => {
		const screen = listed(2);
		screen.localizations.ja = {
			display_name: 'アンケート',
			fields: {
				heard: { label: 'どこで知りましたか？', options: { friend: '友人' } }
			}
		};
		const preview = savedScreenPreview(screen);
		const localized = localizedScreenPreview(preview, 'ja');
		expect(localized.label).toBe('アンケート');
		expect(localized.rows[1].columns[0][0].label).toBe('どこで知りましたか？');
		expect(
			localized.settings.heard.options.find((option) => option.value === 'friend')?.label
		).toBe('友人');
		expect(screen.fields[1].label).toBe('How did you hear about us?');
		expect(preview.settings.heard.options.find((option) => option.value === 'friend')?.label).toBe(
			'A friend'
		);
	});
});
