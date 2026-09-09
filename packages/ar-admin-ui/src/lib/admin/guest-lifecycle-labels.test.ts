import { get } from 'svelte/store';
import { afterEach, expect, it } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
afterEach(() => setLocale('en'));
it('renders deletion and retry state labels in English', () => {
	setLocale('en');
	expect(get(LL).admin_lifecycle_phaseValue({ phase: 'deleting' })).toBe('Deleting');
	expect(get(LL).admin_lifecycle_maintenanceValue({ state: 'retrying' })).toBe('Retry pending');
});
it('renders deletion and retry state labels in Japanese', () => {
	setLocale('ja');
	expect(get(LL).admin_lifecycle_phaseValue({ phase: 'deleting' })).toBe('削除中');
	expect(get(LL).admin_lifecycle_maintenanceValue({ state: 'retrying' })).toBe('再試行待ち');
});
