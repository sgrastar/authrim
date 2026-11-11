<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { createFakePlatformProfiles } from '#lib/api/fake/platform-profiles-fake.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import type { PlatformProfile } from '#lib/api/platform-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { settingText } from '#lib/settings/setting-text.js';
	import PlatformProfilePage from './PlatformProfilePage.svelte';
	import PlatformProfilesPage from './PlatformProfilesPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Platform/Authentication profiles',
		component: PlatformProfilesPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Platform → Authentication → method or session profiles: the platform’s own profiles (locked or not, how many tenants keep a copy; lock, delete, edit), and on the second tab its Default under every tenant’s with the switches for what tenants may do (SettingsPage at the platform scope).'
				}
			}
		}
	});

	const platform = persona('platform').access;
	const hrefOf = (id: string) => `/admin/platform/authentication/session-profiles/${id}`;
	const onopen = fn();
	const oncreated = fn();
	const ondeleted = fn();
	const label = (key: string) => t(settingText(key).label);
	const profile = (overrides: Partial<PlatformProfile>): PlatformProfile => ({
		id: 'psp_short',
		name: 'Short sessions',
		values: { 'session.default_ttl': 3_600_000 },
		version: 1,
		locked: false,
		state: 'active',
		overridingTenants: 0,
		created_at: Date.UTC(2026, 10, 1),
		updated_at: Date.UTC(2026, 10, 7),
		...overrides
	});
	const methods = createFakePlatformProfiles('pmp_');
	// A method profile saved elsewhere with nothing set (every method allowed at sign-in).
	const sparse = createFakePlatformProfiles('pmp_', [
		{
			id: 'pmp_sparse',
			name: 'Anything goes',
			values: {},
			version: 1,
			locked: false,
			state: 'active',
			overridingTenants: 0,
			created_at: null,
			updated_at: null
		}
	]);
	// Someone else changes the profile while it is open here.
	const shared = createFakePlatformProfiles(
		'psp_',
		[
			{
				id: 'psp_kiosk',
				name: 'Kiosk',
				values: {},
				version: 1,
				locked: false,
				state: 'active',
				overridingTenants: 0,
				created_at: null,
				updated_at: null
			}
		],
		{ inUse: ['psp_kiosk'] }
	);
	const sessions = () =>
		createFakePlatformProfiles(
			'psp_',
			[
				profile({ overridingTenants: 3 }),
				profile({ id: 'psp_kiosk', name: 'Kiosk', locked: true, overridingTenants: 1 })
			],
			{ inUse: ['psp_kiosk'] }
		);
</script>

<!-- The platform's profiles: locked ones are badged, each says how many tenants keep a copy; one a tenant's flow uses is not deleted. -->
<Story
	name="Profiles"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Short sessions');
		await expect(canvas.getByText(t('pp.list.overridingCount', { count: 3 }))).toBeInTheDocument();
		await expect(canvas.getByText(t('pl.locked'))).toBeInTheDocument();
		await userEvent.click(
			canvas.getByRole('button', { name: t('pp.list.actions', { name: 'Kiosk' }) })
		);
		const menu = await within(document.body).findByRole('menu');
		await userEvent.click(within(menu).getByText(t('pp.list.delete')));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('pp.list.delete') }));
		// A tenant's flow uses it: refused, and still listed.
		await waitFor(() =>
			expect(within(document.body).queryByRole('dialog')).not.toBeInTheDocument()
		);
		await expect(await canvas.findByText('Kiosk')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<PlatformProfilesPage
			kind="session"
			profiles={sessions()}
			settings={createFakeSettings()}
			canWrite
			{hrefOf}
			{onopen}
			access={platform}
		/>
	{/snippet}
</Story>

<!-- The platform's Default and what tenants may do: settings at the platform scope. -->
<Story
	name="Default and permissions"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(label('session.default_ttl'));
		await expect(
			canvas.getAllByText(label('profiles.session.tenant_change_allowed')).length
		).toBeGreaterThan(0);
		await expect(
			canvas.getAllByText(label('profiles.session.default_locked')).length
		).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		<PlatformProfilesPage
			kind="session"
			profiles={sessions()}
			settings={createFakeSettings()}
			canWrite
			{hrefOf}
			{onopen}
			access={platform}
			tab="default"
		/>
	{/snippet}
</Story>

<!-- Editing one: the name and values; locking it is its own change, told to the tenants that keep a copy. -->
<Story
	name="Edit and lock"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('pp.page.name') });
		await expect(canvas.getByText(t('pp.page.overriding', { count: 3 }))).toBeInTheDocument();
		await userEvent.clear(name);
		await userEvent.type(name, 'Shorter sessions');
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.save') }));
		await canvas.findByRole('heading', { name: 'Shorter sessions' });
		await userEvent.click(canvas.getByRole('button', { name: t('pp.list.lock') }));
		await canvas.findByText(t('pp.page.lockedNote'));
		await expect(canvas.getByRole('button', { name: t('pp.list.unlock') })).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="session"
			client={sessions()}
			id="psp_short"
			canWrite
			listHref="/admin/platform/authentication/session-profiles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<!-- A new method profile starts with every method off (an unset one would look off anyway). -->
<Story
	name="New method profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('pp.page.name') });
		await userEvent.type(name, 'Passkeys only');
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('pmp_1'));
		// Saved explicitly off, guest use included: an unset one would let it through.
		const saved = await methods.get('pmp_1');
		await expect(saved.values['authentication-methods.guest.login_enabled']).toBe(false);
		await expect(saved.values['authentication-methods.passkey.login_enabled']).toBe(false);
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="method"
			client={methods}
			id="new"
			canWrite
			listHref="/admin/platform/authentication/methods"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<!-- Read only: an admin who may see the platform's profiles but not change them. -->
<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Short sessions' });
		await expect(canvas.queryByRole('button', { name: t('pp.list.lock') })).not.toBeInTheDocument();
		await expect(
			canvas.queryByRole('region', { name: t('common.unsaved') })
		).not.toBeInTheDocument();
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="session"
			client={sessions()}
			id="psp_short"
			canWrite={false}
			listHref="/admin/platform/authentication/session-profiles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<!-- A delete the platform refuses (a tenant's flow uses it) keeps the edits made on the page. -->
<Story
	name="Delete refused keeps the edits"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('pp.page.name') });
		await userEvent.clear(name);
		await userEvent.type(name, 'Kiosk (edited)');
		await userEvent.click(canvas.getByRole('button', { name: t('pp.list.delete') }));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('pp.list.delete') }));
		await waitFor(() =>
			expect(within(document.body).queryByRole('dialog')).not.toBeInTheDocument()
		);
		await expect(ondeleted).not.toHaveBeenCalled();
		await expect(canvas.getByRole('textbox', { name: t('pp.page.name') })).toHaveValue(
			'Kiosk (edited)'
		);
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="session"
			client={sessions()}
			id="psp_kiosk"
			canWrite
			listHref="/admin/platform/authentication/session-profiles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<!-- A method the profile leaves unset is allowed at sign-in: it shows as on, not off. -->
<Story
	name="Unset methods show as allowed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('pp.page.name') });
		const boxes = canvas.getAllByRole('checkbox');
		await expect(boxes.length).toBeGreaterThan(0);
		for (const box of boxes) await expect(box).toBeChecked();
		await expect(
			canvas.queryByRole('region', { name: t('common.unsaved') })
		).not.toBeInTheDocument();
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="method"
			client={sparse}
			id="pmp_sparse"
			canWrite
			listHref="/admin/platform/authentication/methods"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<!-- Saving edits made on a version someone else has since moved on is a conflict, even after the page reread the profile (a refused delete). -->
<Story
	name="Saving over a newer version is a conflict"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('pp.page.name') });
		await shared.update('psp_kiosk', 1, { name: 'Kiosk (theirs)', values: {} });
		await userEvent.clear(name);
		await userEvent.type(name, 'Kiosk (mine)');
		await userEvent.click(canvas.getByRole('button', { name: t('pp.list.delete') }));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('pp.list.delete') }));
		await waitFor(() =>
			expect(within(document.body).queryByRole('dialog')).not.toBeInTheDocument()
		);
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.save') }));
		await waitFor(async () => expect((await shared.get('psp_kiosk')).name).toBe('Kiosk (theirs)'));
		await expect(canvas.getByRole('textbox', { name: t('pp.page.name') })).toHaveValue(
			'Kiosk (mine)'
		);
	}}
>
	{#snippet template()}
		<PlatformProfilePage
			kind="session"
			client={shared}
			id="psp_kiosk"
			canWrite
			listHref="/admin/platform/authentication/session-profiles"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>
