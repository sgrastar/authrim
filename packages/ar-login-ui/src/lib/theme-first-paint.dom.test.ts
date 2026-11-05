import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFirstPaintThemeScript } from './theme-bootstrap';

/** Run the script as the browser does: the source between the tags, against the live document. */
function runScript(darkBackground: string) {
	const html = buildFirstPaintThemeScript(darkBackground);
	const source = html.replace(/^<script>/, '').replace(/<\/script>$/, '');
	new Function(source)();
}

function stubSystemScheme(dark: boolean) {
	vi.stubGlobal(
		'matchMedia',
		vi.fn((query: string) => ({ matches: dark && query.includes('dark') }))
	);
	window.matchMedia = globalThis.matchMedia;
}

describe('first-paint theme script (auto tenant, no hint cookie)', () => {
	beforeEach(() => {
		document.documentElement.removeAttribute('style');
		document.documentElement.setAttribute('data-theme', 'light');
		document.head.innerHTML = '<meta name="theme-color" content="#eef1f6" />';
		document.body.removeAttribute('style');
		document.body.innerHTML = '<div class="login-ui-theme-boundary" data-theme="light"></div>';
		localStorage.clear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('opens dark on a dark device: attributes, colour scheme, first-frame colours', () => {
		stubSystemScheme(true);
		runScript('#0b0e16');

		const boundary = document.querySelector('.login-ui-theme-boundary')!;
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(boundary.getAttribute('data-theme')).toBe('dark');
		expect(document.documentElement.style.colorScheme).toBe('dark');
		expect(document.documentElement.style.backgroundColor).toBe('rgb(11, 14, 22)');
		expect(document.body.style.backgroundColor).toBe('rgb(11, 14, 22)');
		expect(document.querySelector('meta[name=theme-color]')!.getAttribute('content')).toBe(
			'#0b0e16'
		);
	});

	it('stays light on a light device', () => {
		stubSystemScheme(false);
		runScript('#0b0e16');

		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		expect(document.querySelector('.login-ui-theme-boundary')!.getAttribute('data-theme')).toBe(
			'light'
		);
		expect(document.documentElement.style.colorScheme).toBe('light');
		// The server's light first frame is left as it is.
		expect(document.documentElement.style.backgroundColor).toBe('');
		expect(document.querySelector('meta[name=theme-color]')!.getAttribute('content')).toBe(
			'#eef1f6'
		);
	});

	it('takes the visitor’s saved choice over the device', () => {
		stubSystemScheme(true);
		localStorage.setItem('authrim-theme', 'light');
		runScript('#0b0e16');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');

		stubSystemScheme(false);
		localStorage.setItem('authrim-theme', 'dark');
		runScript('#0b0e16');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('ignores a saved value that is not a mode, and survives unreadable storage', () => {
		stubSystemScheme(true);
		localStorage.setItem('authrim-theme', 'sepia');
		runScript('#0b0e16');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		document.documentElement.setAttribute('data-theme', 'light');
		expect(() => runScript('#0b0e16')).not.toThrow();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		vi.restoreAllMocks();
	});

	it('patches the boundary the moment the parser inserts it, when it runs in the head', async () => {
		stubSystemScheme(true);
		// In the head, the body has no content yet: the boundary arrives after the script ran.
		document.body.innerHTML = '';
		runScript('#0b0e16');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(document.body.style.backgroundColor).toBe('rgb(11, 14, 22)');

		const boundary = document.createElement('div');
		boundary.className = 'login-ui-theme-boundary';
		boundary.setAttribute('data-theme', 'light');
		document.body.append(boundary);
		// Observer callbacks run at the next microtask checkpoint, before rendering.
		await Promise.resolve();
		expect(boundary.getAttribute('data-theme')).toBe('dark');

		// Done: later insertions are not touched.
		const later = document.createElement('div');
		later.className = 'login-ui-theme-boundary';
		later.setAttribute('data-theme', 'light');
		document.body.append(later);
		await Promise.resolve();
		expect(later.getAttribute('data-theme')).toBe('light');
	});

	it('does not put the old mode back once it is done (a theme change before DOMContentLoaded)', async () => {
		stubSystemScheme(true);
		document.body.innerHTML = '';
		runScript('#0b0e16');
		const boundary = document.createElement('div');
		boundary.className = 'login-ui-theme-boundary';
		document.body.append(boundary);
		await Promise.resolve();
		expect(boundary.getAttribute('data-theme')).toBe('dark');

		// The page switches mode after hydration; the late event must leave it alone.
		boundary.setAttribute('data-theme', 'light');
		document.body.style.colorScheme = 'light';
		document.dispatchEvent(new Event('DOMContentLoaded'));
		expect(boundary.getAttribute('data-theme')).toBe('light');
		expect(document.body.style.colorScheme).toBe('light');
	});

	it('still settles a page whose boundary never comes, at DOMContentLoaded', async () => {
		stubSystemScheme(true);
		document.body.innerHTML = '';
		runScript('#0b0e16');
		const late = document.createElement('p');
		document.body.append(late);
		await Promise.resolve();
		document.dispatchEvent(new Event('DOMContentLoaded'));
		expect(document.body.style.colorScheme).toBe('dark');
		// Finished: a boundary that appears afterwards is the page's own.
		const boundary = document.createElement('div');
		boundary.className = 'login-ui-theme-boundary';
		boundary.setAttribute('data-theme', 'light');
		document.body.append(boundary);
		await Promise.resolve();
		expect(boundary.getAttribute('data-theme')).toBe('light');
	});

	it('cannot be ended early or escaped by the colour it embeds', () => {
		const html = buildFirstPaintThemeScript('</script><script>alert(1)</script>"');
		// One script element: the only `</script>` is the closing tag.
		expect(html.match(/<\/script>/g)).toHaveLength(1);
		expect(html.match(/<script>/g)).toHaveLength(1);
	});
});
