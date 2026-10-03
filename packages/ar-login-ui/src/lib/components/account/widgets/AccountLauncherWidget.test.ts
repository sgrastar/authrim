import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountLauncherWidget from './AccountLauncherWidget.svelte';
import { launcher, launchers } from './fixtures';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

function renderLauncher(props: Partial<Parameters<typeof AccountLauncherWidget>[1]> = {}) {
	return render(AccountLauncherWidget, {
		props: { onRetry: () => undefined, onToggleFavorite: () => undefined, ...props }
	}).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountLauncherWidget', () => {
	it('announces loading as a status instead of labelling a plain div', () => {
		setLocale('en');
		const body = renderLauncher({ loading: true });

		expect(body).toContain('aria-busy="true"');
		expect(body).toMatch(/role="status"[^>]*>\s*<span class="sr-only[^"]*">Loading/);
		expect(body).not.toMatch(/<div[^>]*aria-label=/);
		expect(body).not.toContain('No applications');
	});

	it('names each favourite toggle after its launcher and reports its state', () => {
		setLocale('en');
		const body = renderLauncher({ launchers: launchers() });

		expect(body).toMatch(/aria-pressed="true"[^>]*aria-label="Team calendar: Favorites"/);
		expect(body).toMatch(/aria-pressed="false"[^>]*aria-label="Expenses: Favorites"/);
		// Mail does not allow favourites.
		expect(body).not.toContain('Mail: Favorites');
	});

	it('draws image and icon tiles, the legacy tag and the launcher count', () => {
		setLocale('en');
		const body = renderLauncher({ launchers: launchers() });

		expect(body).toContain('i-ph-calendar');
		expect(body).toContain('src="data:image/svg+xml');
		expect(body).toContain('Legacy mode');
		expect(body).toMatch(/class="count[^"]*">4</);
		expect(body).toContain('target="_blank"');
		expect(body).toContain('rel="noopener noreferrer"');
	});

	it('marks a favourite being saved as waiting', () => {
		setLocale('en');
		const body = renderLauncher({
			launchers: [launcher()],
			favoriteLoading: ['launcher-calendar']
		});

		expect(body).toMatch(/<button[^>]*disabled[^>]*aria-label="Team calendar: Favorites"/);
	});

	it('offers a retry when loading failed, and explains an empty list', () => {
		setLocale('en');
		const failed = renderLauncher({ error: 'Applications could not be loaded.' });
		expect(failed).toMatch(/role="alert"[^>]*>Applications could not be loaded\./);
		expect(failed).toContain('Refresh');

		expect(renderLauncher()).toContain('No applications are available.');
	});

	it('is a card with an h2 on its own and an h3 inside a parent panel', () => {
		setLocale('ja');
		expect(renderLauncher()).toMatch(/<h2[^>]*>マイアプリ<\/h2>/);
		const nested = renderLauncher({ headingLevel: 3, title: 'Apps' });
		expect(nested).toMatch(/<h3[^>]*>Apps<\/h3>/);
		expect(nested).not.toContain('class="card');
	});
});
