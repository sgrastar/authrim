import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountDevicesWidget from './AccountDevicesWidget.svelte';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

describe('AccountDevicesWidget', () => {
	it('explains that connected devices are separate from browser sign-ins', () => {
		setLocale('ja');
		const body = render(AccountDevicesWidget, { props: { devices: [] } }).body.replace(
			HYDRATION_MARKERS,
			''
		);

		expect(body).toContain('連携済みアプリ・端末');
		expect(body).toContain('アカウントに連携したアプリと端末です');
		expect(body).toContain('連携済みのアプリ・端末はありません');
	});

	it('is a card with an h2 on its own and an h3 inside a parent panel', () => {
		setLocale('en');
		const own = render(AccountDevicesWidget, { props: {} }).body.replace(HYDRATION_MARKERS, '');
		const nested = render(AccountDevicesWidget, { props: { headingLevel: 3 } }).body.replace(
			HYDRATION_MARKERS,
			''
		);

		expect(own).toMatch(/<h2[^>]*>Connected apps and devices<\/h2>/);
		expect(own).toContain('class="card');
		expect(nested).toMatch(/<h3[^>]*>Connected apps and devices<\/h3>/);
		expect(nested).not.toContain('class="card');
	});

	it('lists each device with its platform and marks the current one', () => {
		setLocale('en');
		const body = render(AccountDevicesWidget, {
			props: {
				devices: [
					{
						id: 'device-1',
						display_name: 'Work laptop',
						platform: 'macOS',
						current: true,
						last_seen_at: null,
						last_seen_at_unix: Date.UTC(2026, 7, 9, 10, 30) / 1000
					}
				]
			}
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('Work laptop');
		expect(body).toContain('macOS /');
		expect(body).toContain('Current');
	});
});
