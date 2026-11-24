import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { loadAllLocales } from '$i18n/i18n-util.sync';
import { setLocale } from '$i18n/i18n-svelte';
import RuntimeFallbackPanel from './RuntimeFallbackPanel.svelte';

loadAllLocales();

const item = (text_display: 'inline' | 'modal' | null, require_scroll: boolean | null) => ({
	statement_id: 'tos',
	slug: 'tos',
	category: 'terms',
	title: 'Terms',
	description: '',
	document_url: null,
	inline_content: '<p>The text.</p>',
	version: '20261113',
	version_id: 'v1',
	is_required: true,
	content_mode: 'checkbox' as const,
	options: [],
	attribute_value_display: null,
	checkbox_mode: 'required' as const,
	checkbox_default_checked: false,
	text_display,
	require_scroll,
	binding_type: null,
	binding_value: null,
	evidence_profile: null,
	language_fallback: null,
	display_order: 0
});

const step = (policyItem: ReturnType<typeof item>) => ({
	component: 'consent_policy',
	isAuthStep: false,
	screen: null,
	title: 'Consent',
	description: '',
	consentPolicy: {
		id: 'p',
		display_name: '',
		description: null,
		language: 'en',
		default_language: 'en',
		items: [policyItem]
	},
	destinationFieldConsent: null
});

describe('the consent step without a screen of its own', () => {
	it("keeps a statement's own presentation: a dialog, and the scroll requirement", () => {
		setLocale('en');
		const body = render(RuntimeFallbackPanel, {
			props: { step: step(item('modal', true)) as never }
		}).body;
		expect(body).toContain('Open Terms');
		expect(body).not.toContain('statement-consent-frame');
	});

	it('draws the text in place when the step says nothing', () => {
		setLocale('en');
		const body = render(RuntimeFallbackPanel, {
			props: { step: step(item(null, null)) as never }
		}).body;
		expect(body).not.toContain('Open Terms');
		expect(body).toContain('statement-consent-frame');
	});
});
