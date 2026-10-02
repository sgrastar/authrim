// @vitest-environment jsdom

import { flushSync } from 'svelte';
import { readable } from 'svelte/store';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSettings = vi.hoisted(() => vi.fn());

vi.mock('$i18n/i18n-svelte', () => ({
	// Each message renders as its key, so the test reads which one is shown.
	LL: readable(new Proxy({}, { get: (_target, key) => () => String(key) }))
}));
vi.mock('$lib/api/admin-settings', () => ({ adminSettingsAPI: { getSettings } }));
vi.mock('$lib/stores/settings-context.svelte', () => ({
	settingsContext: { tenantId: 'default' }
}));

import ProfileUpdateFieldsEditor from './ProfileUpdateFieldsEditor.svelte';

function tenantDefault(fields: unknown) {
	return { values: { 'external_idp.jit_update_fields': fields } };
}

function defaultSwitch(): HTMLElement {
	return screen.getByRole('switch');
}

describe('ProfileUpdateFieldsEditor', () => {
	afterEach(() => {
		cleanup();
		getSettings.mockReset();
	});

	it('shows a value the parent reloads, so the page saves what it shows', async () => {
		getSettings.mockResolvedValue(tenantDefault(['name']));
		const view = render(ProfileUpdateFieldsEditor, { value: ['locale'] });
		expect(screen.getByRole('checkbox', { name: 'locale' })).toHaveProperty('checked', true);

		await view.rerender({ value: null });
		flushSync();

		expect(screen.queryByRole('checkbox', { name: 'locale' })).toBeNull();
		expect(defaultSwitch().getAttribute('aria-checked')).toBe('true');
	});

	it('turns the tenant default off only once it is read, starting from its fields', async () => {
		let resolve!: (value: unknown) => void;
		getSettings.mockReturnValue(new Promise((r) => (resolve = r)));
		render(ProfileUpdateFieldsEditor, { value: null });

		expect(
			screen.getByText('admin_external_idp_profile_update_fields_tenant_loading')
		).toBeTruthy();
		expect(defaultSwitch().hasAttribute('disabled')).toBe(true);

		resolve(tenantDefault(['name', 'picture']));
		await waitFor(() => expect(defaultSwitch().hasAttribute('disabled')).toBe(false));
		expect(screen.getByText('name, picture')).toBeTruthy();

		defaultSwitch().click();
		flushSync();
		expect(screen.getByRole('checkbox', { name: 'name' })).toHaveProperty('checked', true);
		expect(screen.getByRole('checkbox', { name: 'picture' })).toHaveProperty('checked', true);
		expect(screen.getByRole('checkbox', { name: 'locale' })).toHaveProperty('checked', false);
	});

	it('keeps following the tenant when its default cannot be read', async () => {
		getSettings.mockRejectedValue(new Error('unavailable'));
		render(ProfileUpdateFieldsEditor, { value: null });

		await waitFor(() =>
			expect(
				screen.getByText('admin_external_idp_profile_update_fields_tenant_failed')
			).toBeTruthy()
		);
		expect(defaultSwitch().hasAttribute('disabled')).toBe(true);
	});

	it('lets an IdP with its own fields go back to the tenant default even if it cannot be read', async () => {
		getSettings.mockRejectedValue(new Error('unavailable'));
		render(ProfileUpdateFieldsEditor, { value: [] });
		await waitFor(() => expect(getSettings).toHaveBeenCalled());

		expect(defaultSwitch().hasAttribute('disabled')).toBe(false);
		expect(screen.getByText('admin_external_idp_profile_update_fields_none')).toBeTruthy();
	});
});
