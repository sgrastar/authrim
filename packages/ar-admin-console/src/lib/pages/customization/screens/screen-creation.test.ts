import { describe, expect, it } from 'vitest';
import { SCREEN_KINDS, type ScreenKind, type ScreenListItem } from '#lib/api/screens.js';
import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
import {
	SCREEN_CATEGORIES,
	screenCategory,
	screenInputFromTemplate,
	screenKeyIsValid,
	screenTemplates
} from './screen-creation';

const row = (index: number): ScreenListItem => ({
	...structuredClone(MOCK_SCREENS[0]),
	id: `system_${index}`,
	screen_key: `preset_${index}`,
	usage: { flows: 0, account_pages: 0 }
});

describe('screen creation templates', () => {
	it('places every screen kind in one of the five categories', () => {
		const expected: Record<ScreenKind, string> = {
			registration: 'registration',
			profile_completion: 'registration',
			login: 'login',
			code_input: 'login',
			account: 'account',
			consent: 'consent',
			custom: 'other'
		};
		expect(SCREEN_KINDS.map((kind) => [kind, screenCategory(kind)])).toEqual(
			SCREEN_KINDS.map((kind) => [kind, expected[kind]])
		);
		expect(SCREEN_CATEGORIES).toEqual(['registration', 'login', 'account', 'consent', 'other']);
	});

	it('shows saved system presets and a starter only for categories without one', () => {
		const registration = { ...row(1), screen_kind: 'registration' as const };
		const completion = { ...row(2), screen_kind: 'profile_completion' as const };
		const custom = { ...row(3), screen_kind: 'custom' as const, is_system: false };
		const empty = { ...row(4), screen_kind: 'account' as const, fields: [] };
		const items = screenTemplates([registration, completion, custom, empty], 'Blank starter');

		expect(items.filter((item) => item.groupId === 'registration').map((item) => item.id)).toEqual([
			registration.id,
			completion.id
		]);
		expect(items.find((item) => item.groupId === 'account')).toMatchObject({
			id: 'blank:account',
			kind: 'account',
			source: null
		});
		expect(items.find((item) => item.groupId === 'other')).toMatchObject({
			id: 'blank:other',
			kind: 'custom',
			source: null
		});
		expect(items.some((item) => item.id === custom.id || item.id === empty.id)).toBe(false);
	});

	it('copies a preset and records its source without sharing mutable data', () => {
		const source = row(1);
		const template = screenTemplates([source], 'Blank').find((item) => item.id === source.id)!;
		const input = screenInputFromTemplate(template, {
			name: ' My sign-in ',
			key: ' my_login ',
			description: ' Description '
		});

		expect(input).toMatchObject({
			display_name: 'My sign-in',
			screen_key: 'my_login',
			description: 'Description',
			screen_kind: 'login',
			is_active: true,
			settings: {
				base_preset_key: source.screen_key,
				base_preset_version: 1
			}
		});
		expect(input.fields).toEqual(source.fields);
		expect(input.fields).not.toBe(source.fields);
		expect(input.localizations).not.toBe(source.localizations);
		expect(input.localizations.ja).toEqual({ fields: source.localizations.ja.fields });
		expect(input.settings).not.toBe(source.settings);
		input.fields[0].label = 'Changed';
		expect(source.fields[0].label).toBe('Sign in');
	});

	it('creates a valid, nonempty starter and rejects invalid key shapes', () => {
		const blank = screenTemplates([], 'Blank').find((item) => item.groupId === 'other')!;
		const input = screenInputFromTemplate(blank, {
			name: ' First screen ',
			key: 'first_screen',
			description: ' '
		});
		expect(input).toMatchObject({
			screen_kind: 'custom',
			fields: [{ field: 'title', block_type: 'heading', label: 'First screen' }],
			settings: { canvas_layout: 'narrow' },
			description: null
		});
		expect(screenKeyIsValid(input.screen_key!)).toBe(true);
		expect(['', 'UPPER', 'has space', 'a'.repeat(97)].every((key) => !screenKeyIsValid(key))).toBe(
			true
		);
	});
});
