<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { createFakeLiteMode } from '#lib/api/fake/login-ui-lite-mode-fake.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LoginUiPage from './LoginUiPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Login UI',
		component: LoginUiPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Login UI: the languages the sign-in screens offer, one question per step — which languages are shown (a choice grid; the default stays on), which is the default (a select limited to those shown), which are listed first (a second grid, up to six, from eleven shown), and whether English names are added. Read from and saved to the tenant’s `login-ui` settings with the version read. Below them, the lite Login UI: its switch (immediate, confirmed first, refused with the reasons while the tenant is not ready) and its logo (a small PNG or WebP kept as a data: URI, saved with the page). The look of the screens is a theme’s (Branding), not here.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const settings = (stored: Record<string, unknown> = {}, locked: string[] = []) =>
		createFakeSettings({
			access: () => adminAccess.current,
			latency: 200,
			stored: { [`tenant:${TENANT}`]: stored },
			locked
		});
</script>

<Story
	name="Defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('lu.shown'));
		// Every language the screens know is shown, so "listed first" is offered: automatic until
		// the admin chooses, then a second grid.
		// The option's name carries its description too: match the start.
		const auto = canvas.getByRole('checkbox', {
			name: (name) => name.startsWith(t('lu.first.auto'))
		});
		await expect(auto).toBeChecked();
		await expect(canvas.getAllByRole('group')).toHaveLength(1);
		await userEvent.click(auto);
		await expect(canvas.getAllByRole('group')).toHaveLength(2);
		const [shown] = canvas.getAllByRole('group');
		// The default stays on when all are cleared.
		await userEvent.click(within(shown).getByRole('button', { name: t('table.clearSelection') }));
		const checked = within(shown).getAllByRole('checkbox', { checked: true });
		await expect(checked).toHaveLength(1);
		await expect(checked[0]).toBeDisabled();
		// With fewer than eleven languages shown, "listed first" is explained, not offered.
		await expect(canvas.getByText(t('lu.first.needsMore', { n: 11 }))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LoginUiPage client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Few languages, Japanese default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('lu.shown'));
		await expect(canvas.getByText(t('lu.first.needsMore', { n: 11 }))).toBeInTheDocument();
		await expect(canvas.getAllByRole('group')).toHaveLength(1);
	}}
>
	{#snippet template()}
		<LoginUiPage
			client={settings({
				'login-ui.supported_locales': 'ja,en,zh-CN',
				'login-ui.default_locale': 'ja',
				'login-ui.show_english_language_names': true
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Lite Login UI ready to switch on"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = await canvas.findByRole('switch', { name: t('lu.lite.switch') });
		await expect(toggle).toBeEnabled();
		await expect(toggle).not.toBeChecked();
		// Switching asks first; giving up leaves the switch as it was.
		await userEvent.click(toggle);
		await expect(await canvas.findByText(t('lu.lite.confirmOn.title'))).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('common.cancel') }));
		await waitFor(() => expect(canvas.queryByText(t('lu.lite.confirmOn.title'))).toBeNull());
		await expect(canvas.getByRole('switch', { name: t('lu.lite.switch') })).not.toBeChecked();
	}}
>
	{#snippet template()}
		<LoginUiPage client={settings()} lite={createFakeLiteMode({ delay: 200 })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Switch the lite Login UI on, then save a language setting"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = await canvas.findByRole('switch', { name: t('lu.lite.switch') });
		await userEvent.click(toggle);
		await userEvent.click(await canvas.findByRole('button', { name: t('lu.lite.confirmOn.ok') }));
		await waitFor(() =>
			expect(canvas.getByRole('switch', { name: t('lu.lite.switch') })).toBeChecked()
		);
		// The switch recorded its mode in the same settings: a save right after still works.
		await userEvent.click(
			canvas.getByRole('checkbox', { name: (name) => name.startsWith(t('lu.englishNames')) })
		);
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull()
		);
	}}
>
	{#snippet template()}
		{@const shared = settings()}
		<LoginUiPage
			client={shared}
			lite={createFakeLiteMode({ delay: 200, settings: { client: shared, tenantId: TENANT } })}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Lite Login UI not ready"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = await canvas.findByRole('switch', { name: t('lu.lite.switch') });
		await expect(toggle).toBeDisabled();
		await expect(canvas.getByText(t('lu.lite.issues.title'))).toBeInTheDocument();
		await expect(canvas.getByText(/did/)).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LoginUiPage
			client={settings()}
			lite={createFakeLiteMode({
				delay: 200,
				issues: [
					{ code: 'method_unsupported', subject: 'did' },
					{ code: 'client_login_ui_url', subject: 'client_portal' }
				]
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Lite Login UI on"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = await canvas.findByRole('switch', { name: t('lu.lite.switch') });
		await expect(toggle).toBeChecked();
	}}
>
	{#snippet template()}
		<LoginUiPage
			client={settings({ 'login-ui.lite_mode': 'always' })}
			lite={createFakeLiteMode({ delay: 200, mode: 'always' })}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Custom content blocks"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('lu.blocks'));
		// Two saved blocks are rows; a new one is empty and holds the save until written.
		await expect(
			canvas.getByDisplayValue('Available from the campus network only')
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('lu.blocks.add') }));
		await expect(canvas.getByText(t('lu.blocks.problem.content.text'))).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('lu.blocks.remove', { n: 3 }) }));
		await waitFor(() => expect(canvas.queryByText(t('lu.blocks.problem.content.text'))).toBeNull());
	}}
>
	{#snippet template()}
		<LoginUiPage
			client={settings({
				'login-ui.custom_blocks': JSON.stringify([
					{
						position: 'below-form',
						type: 'text',
						content: 'Available from the campus network only'
					},
					{
						position: 'below-footer',
						type: 'link',
						content: 'Privacy notice',
						url: 'https://example.test/privacy'
					}
				])
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Languages fixed by the platform"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() =>
			expect(canvas.getAllByText(t('settings.locked.platform')).length).toBeGreaterThan(0)
		);
	}}
>
	{#snippet template()}
		<LoginUiPage
			client={settings({}, ['login-ui.supported_locales', 'login-ui.default_locale'])}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>
