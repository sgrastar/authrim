import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { i18n, t } from '#lib/i18n/i18n.svelte.js';
import { SUPPORTED_LOCALES } from '#lib/i18n/locales.js';
import TenantCopyFields from './TenantCopyFields.svelte';
import { defaultCopyOptions } from './tenant-model';

const initialLocale = i18n.locale;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	i18n.set(initialLocale);
});

describe('SAML tenant copy description', () => {
	it.each(SUPPORTED_LOCALES)('renders a nonempty visible description in %s', (locale) => {
		i18n.set(locale);
		const root = document.createElement('div');
		document.body.append(root);
		cleanups.push(async () => root.remove());
		const fields = mount(TenantCopyFields, {
			target: root,
			props: { options: defaultCopyOptions() }
		});
		cleanups.push(() => unmount(fields));
		flushSync();

		const description = t('tn.copy.samlProviders.desc');
		expect(description.trim()).not.toBe('');
		expect(description).not.toBe('tn.copy.samlProviders.desc');
		const checkbox = Array.from(
			root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
		).find((input) => input.labels?.[0]?.textContent?.includes(t('tn.copy.samlProviders')));
		expect(checkbox).toBeDefined();
		expect(checkbox).not.toBeChecked();
		const text = checkbox?.labels?.[0]?.querySelector('.checkbox__desc');
		expect(text).toHaveTextContent(description);
		expect(text).toBeVisible();
	});
});
