<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { settingText } from '#lib/settings/setting-text.js';
	import SessionProfilePage from './SessionProfilePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Session profile',
		component: SessionProfilePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A session profile: the session lengths (the per-method ones under Advanced), extension and single sign-on, with the same inline name editing as sign-in method profiles. Default is the tenant’s own session settings: saving it changes them. The fields (`SessionProfileFields`) are also shown, read only, where a service flow chooses a profile.'
				}
			}
		}
	});
	const oncreated = fn();

	/** A client whose saves wait until `release()`: what the form does meanwhile. */
	function slowSaves() {
		const client = createFakeSessionProfiles();
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		return {
			client: {
				...client,
				async update(...args: Parameters<typeof client.update>) {
					await held;
					return client.update(...args);
				}
			},
			release: () => release()
		};
	}
	const slow = slowSaves();
	const label = (key: string) => t(settingText(key).label);
</script>

<Story
	name="Create profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('sp.page.name') });
		await userEvent.type(name, 'Kiosk');
		await userEvent.click(canvas.getByRole('button', { name: t('sp.page.nameDone') }));
		await expect(canvas.getByRole('heading', { name: 'Kiosk' })).toBeInTheDocument();
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('sp_1'));
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={createFakeSessionProfiles()}
			id="new"
			canWrite
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="Default profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Default' });
		const sso = canvas.getByRole('combobox', { name: label('oauth.sso_enabled') });
		await expect(sso).toHaveValue('true');
		await userEvent.selectOptions(sso, 'false');
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.discard') }));
		// Discarding starts the fields over: the value is back as it was.
		await waitFor(() =>
			expect(canvas.getByRole('combobox', { name: label('oauth.sso_enabled') })).toHaveValue('true')
		);
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={createFakeSessionProfiles()}
			id="default"
			canWrite
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Default' });
		await expect(canvas.queryByRole('combobox')).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={createFakeSessionProfiles()}
			id="default"
			canWrite={false}
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>

<!-- Default is the tenant's own settings: a length cannot be left empty there (it would not be saved). -->
<Story
	name="Default refuses an empty length"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Default' });
		const length = canvas.getByRole('textbox', { name: label('session.default_ttl') });
		await userEvent.clear(length);
		await userEvent.tab();
		await canvas.findByText(t('sp.fields.required'));
		// Another change is not saved while the empty length stands.
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: label('oauth.sso_enabled') }),
			'false'
		);
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await expect(within(bar).getByText(t('common.fixErrors'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={createFakeSessionProfiles()}
			id="default"
			canWrite
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>

<!-- A saved profile may leave a setting to the Default profile: shown as such, and chosen so. -->
<Story
	name="A saved profile follows Default where it says nothing"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Kiosk' });
		const sso = canvas.getByRole('combobox', { name: label('oauth.sso_enabled') });
		await expect(sso).toHaveValue('inherit');
		await expect(
			canvas.getByRole('combobox', { name: label('session.refresh_default') })
		).toHaveValue('false');
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={createFakeSessionProfiles([
				{
					id: 'sp_kiosk',
					name: 'Kiosk',
					is_system: false,
					version: 1,
					values: { 'session.default_ttl': 900_000, 'session.refresh_default': false },
					created_at: Date.UTC(2026, 10, 1),
					updated_at: Date.UTC(2026, 10, 7)
				}
			])}
			id="sp_kiosk"
			canWrite
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>

<!-- While a save is on its way the form takes no input: the answer replaces it, so a change made meanwhile is never lost while looking saved. -->
<Story
	name="Saving locks the form until the answer"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Default' });
		const sso = () => canvas.getByRole('combobox', { name: label('oauth.sso_enabled') });
		await userEvent.selectOptions(sso(), 'false');
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(sso()).toBeDisabled());
		await expect(
			canvas.getByRole('combobox', { name: label('session.refresh_default') })
		).toBeDisabled();
		slow.release();
		await waitFor(() => expect(sso()).toBeEnabled());
		await expect(sso()).toHaveValue('false');
	}}
>
	{#snippet template()}
		<SessionProfilePage
			client={slow.client}
			id="default"
			canWrite
			listHref="/admin/authentication/session-profiles"
			{oncreated}
		/>
	{/snippet}
</Story>
