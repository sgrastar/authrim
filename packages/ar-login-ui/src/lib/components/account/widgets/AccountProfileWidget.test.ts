import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountProfileWidget from './AccountProfileWidget.svelte';
import { profile } from './fixtures';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

function renderProfile(props: Partial<Parameters<typeof AccountProfileWidget>[1]> = {}) {
	return render(AccountProfileWidget, {
		props: {
			profile: profile(),
			onSave: () => undefined,
			onStartEmailChange: () => undefined,
			onCompleteEmailChange: () => undefined,
			onCancelEmailChange: () => undefined,
			...props
		}
	}).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountProfileWidget', () => {
	it('shows the name and email and labels the name field', () => {
		setLocale('en');
		const body = renderProfile();

		expect(body).toMatch(/<h2[^>]*>Profile<\/h2>/);
		expect(body).toContain('Alice Example');
		expect(body).toContain('alice@example.com');
		expect(body).toMatch(/<label for="([^"]+)"[^>]*>[^<]+<\/label>[\s\S]*<input id="\1"/);
		expect(body).toContain('aria-label="Manage"');
	});

	it('labels the confirmation code field and names the address it went to', () => {
		setLocale('en');
		const body = renderProfile({
			emailChangeStage: 'challenge',
			pendingEmail: 'alice@example.org'
		});

		expect(body).toContain('alice@example.org');
		expect(body).toMatch(
			/<label for="([^"]+)"[^>]*>[^<]+<\/label>[\s\S]*autocomplete="one-time-code"/
		);
		expect(body).not.toContain('aria-label="Manage"');
		expect(body).toContain('pattern="[0-9]{6}"');
	});

	it('announces save and email errors as alerts', () => {
		setLocale('en');
		expect(renderProfile({ error: 'Could not save.' })).toMatch(
			/role="alert"[^>]*>Could not save\./
		);
		expect(
			renderProfile({ emailChangeStage: 'challenge', emailChangeError: 'Invalid code.' })
		).toMatch(/role="alert"[^>]*>Invalid code\./);
	});

	it('shows a skeleton while loading', () => {
		setLocale('en');
		const body = renderProfile({ profile: null, loading: true });

		expect(body).toContain('aria-busy="true"');
		expect(body).toContain('account-section-skeleton');
		expect(body).not.toContain('Save');
	});
});
