import { describe, expect, it } from 'vitest';
import type { SettingsSection } from './placement';
import { sectionNotices } from './setting-notices';
import { fieldOf, type Values } from './settings-model';

const section = (...keys: string[]): SettingsSection => ({
	id: 's',
	title: 'set.section.appTokens',
	settings: keys.map((key) => ({ key, depth: 'primary' as const }))
});
const values = (set: Record<string, unknown>): Values =>
	Object.fromEntries(Object.entries(set).map(([key, v]) => [fieldOf(key), { v, here: true }]));

describe('notices about the consequences of a choice', () => {
	const signing = section(
		'oauth.id_token_signing_alg',
		'oauth.id_token_signing_alg_client_override'
	);

	it('warns that one ID token algorithm other than RS256 departs from Discovery', () => {
		expect(
			sectionNotices(
				signing,
				values({
					'oauth.id_token_signing_alg': 'ES256',
					'oauth.id_token_signing_alg_client_override': false
				})
			)
		).toEqual([{ id: 'idTokenAlgorithm', tone: 'warning' }]);
	});

	it('says nothing while apps may choose, or the tenant signs with RS256', () => {
		for (const set of [
			{ 'oauth.id_token_signing_alg': 'ES256', 'oauth.id_token_signing_alg_client_override': true },
			{ 'oauth.id_token_signing_alg': 'RS256', 'oauth.id_token_signing_alg_client_override': false }
		]) {
			expect(sectionNotices(signing, values(set))).toEqual([]);
		}
	});

	it('notes the FAPI 2.0 requirements as compatibility, only where FAPI is set', () => {
		const fapiOn = values({ 'security.fapi_enabled': true });
		expect(sectionNotices(section('security.fapi_enabled'), fapiOn)).toEqual([
			{ id: 'fapi', tone: 'info' }
		]);
		expect(sectionNotices(signing, fapiOn)).toEqual([]);
		expect(
			sectionNotices(section('security.fapi_enabled'), values({ 'security.fapi_enabled': false }))
		).toEqual([]);
	});
});
