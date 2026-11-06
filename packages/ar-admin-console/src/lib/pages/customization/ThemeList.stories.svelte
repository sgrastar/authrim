<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeLoginUiThemes } from '#lib/api/fake/login-ui-themes-fake.js';
	import type { LoginUiTheme } from '#lib/api/login-ui-themes.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ThemeList from './ThemeList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Themes',
		component: ThemeList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Themes: the tenant’s saved themes (`/api/admin/login-ui/themes`). None at first; “Create theme” at the top end opens a new one (`…/branding/new`). A row opens its theme (`…/branding/<id>`); its menu edits, applies or deletes it. The applied theme is marked, and so is one saved again since (“Changes not applied”). The applied theme cannot be deleted.'
				}
			}
		}
	});

	const HOUR = 3_600_000;
	const now = Date.UTC(2026, 10, 6, 3, 0, 0);
	const theme = (
		id: string,
		name: string,
		template: string,
		palette: string,
		version: number,
		ago: number
	): LoginUiTheme => ({
		id,
		name,
		values: { 'login-ui.template': template, 'login-ui.palette': palette },
		version,
		created_by: 'admin',
		created_at: now - ago - HOUR,
		updated_at: now - ago
	});
	const saved = [
		theme('thm_1', 'Spring campaign', 'split', 'clear-glass', 3, HOUR),
		theme('thm_2', 'Default', 'standard', 'meridian', 1, 30 * HOUR),
		theme('thm_3', 'Partner portal', 'minimal', 'flat', 2, 72 * HOUR)
	];
	const onopen = fn();
	const hrefOf = (id: string) => `/admin/customization/branding/${id}`;
</script>

<Story
	name="None yet"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const shown = await canvas.findByText(t('th.list.empty'));
		await waitFor(() => expect(shown).toBeVisible());
		// The way to the first theme is at the top end.
		await expect(canvas.getByRole('link', { name: t('th.list.create') })).toHaveAttribute(
			'href',
			hrefOf('new')
		);
	}}
>
	{#snippet template()}
		<ThemeList client={createFakeLoginUiThemes()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Saved themes, one applied with changes since"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Spring campaign');
		await waitFor(() => expect(canvas.getByText(t('th.list.active'))).toBeVisible());
		await waitFor(() => expect(canvas.getByText(t('th.list.pending'))).toBeVisible());
		// A row opens its theme.
		await userEvent.click(canvas.getByText('Partner portal'));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('thm_3'));
	}}
>
	{#snippet template()}
		<ThemeList
			client={createFakeLoginUiThemes({ themes: saved, active: { theme_id: 'thm_1', version: 2 } })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="Read only">
	{#snippet template()}
		<ThemeList
			client={createFakeLoginUiThemes({ themes: saved, active: { theme_id: 'thm_2', version: 1 } })}
			canWrite={false}
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>
