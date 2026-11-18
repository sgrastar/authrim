<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
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
						'Customization → Login UI: the languages the sign-in screens offer, one question per step — which languages are shown (a choice grid; the default stays on), which is the default (a select limited to those shown), which are listed first (a second grid, up to six, from eleven shown), and whether English names are added. Read from and saved to the tenant’s `login-ui` settings with the version read. The look of the screens is a theme’s (Branding), not here.'
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
