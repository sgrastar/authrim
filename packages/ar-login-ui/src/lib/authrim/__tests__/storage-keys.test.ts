// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
	LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
	LOGIN_UI_SESSION_STORAGE_KEYS,
	consumeLoginUiSessionItem,
	removeLoginUiSessionItems,
	setLoginUiSessionItem
} from '../storage-keys';

describe('LoginUI session storage keys', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it('uses namespaced keys for new LoginUI session state', () => {
		setLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, 'github');
		setLoginUiSessionItem(
			LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
			'interaction_1'
		);

		expect(sessionStorage.getItem('authrim:loginui:external:provider_id')).toBe('github');
		expect(sessionStorage.getItem('authrim:loginui:external:flow_runtime_interaction_id')).toBe(
			'interaction_1'
		);
		expect(sessionStorage.getItem('oauth_provider_id')).toBeNull();
	});

	it('consumes new and legacy callback keys while preferring the namespaced value', () => {
		sessionStorage.setItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, 'github');
		sessionStorage.setItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalProviderId, 'google');

		const value = consumeLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId, [
			LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalProviderId
		]);

		expect(value).toBe('github');
		expect(sessionStorage.getItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalProviderId)).toBeNull();
		expect(
			sessionStorage.getItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalProviderId)
		).toBeNull();
	});

	it('falls back to legacy callback keys during cleanup-only migration', () => {
		sessionStorage.setItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalReturnUrl, '/dashboard');

		const value = consumeLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalReturnUrl, [
			LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalReturnUrl
		]);

		expect(value).toBe('/dashboard');
		expect(
			sessionStorage.getItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.externalReturnUrl)
		).toBeNull();
	});

	it('removes stale PKCE verifier cleanup keys without touching unrelated state', () => {
		sessionStorage.setItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.pkceCodeVerifier, 'secret');
		sessionStorage.setItem('unrelated', 'keep');

		removeLoginUiSessionItems([LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.pkceCodeVerifier]);

		expect(
			sessionStorage.getItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.pkceCodeVerifier)
		).toBeNull();
		expect(sessionStorage.getItem('unrelated')).toBe('keep');
	});
});
