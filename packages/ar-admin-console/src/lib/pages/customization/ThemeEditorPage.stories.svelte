<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeLoginUiThemes } from '#lib/api/fake/login-ui-themes-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ThemeEditorPage from './ThemeEditorPage.svelte';
	import { draftToValues } from './theme-values';
	import { newThemeDraft } from './theme-draft';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Theme page',
		component: ThemeEditorPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A theme’s page (`…/branding/new`, `…/branding/<id>`). The console’s header carries the way back to the list, the theme’s name, whether it is applied, and Save and Apply; the name is entered just under it, and the theme editor fills the rest. Images chosen in the editor are uploaded on Save. A theme with unsaved changes is not applied: save first, so that what is applied is what was saved.'
				}
			}
		}
	});

	const oncreated = fn();
	const upload = async (_kind: string, file: File) => URL.createObjectURL(file);
	const saved = {
		id: 'thm_1',
		name: 'Spring campaign',
		values: draftToValues({ ...newThemeDraft(), template: 'split', palette: 'clear-glass' }),
		version: 2,
		created_by: 'admin',
		created_at: Date.UTC(2026, 10, 1),
		updated_at: Date.UTC(2026, 10, 5)
	};
</script>

<Story
	name="New theme"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: new RegExp(t('th.page.name')) });
		// Saving without a name asks for one.
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		const shown = await canvas.findByText(t('th.page.nameRequired'));
		await waitFor(() => expect(shown).toBeVisible());
		await userEvent.type(name, 'Autumn');
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('thm_1'));
	}}
>
	{#snippet template()}
		<ThemeEditorPage
			client={createFakeLoginUiThemes()}
			id="new"
			canWrite
			{upload}
			listHref="/admin/customization/branding"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="New theme, changed while it is saved"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: new RegExp(t('th.page.name')) });
		await userEvent.type(name, 'Autumn');
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		// Typed while the theme is saved: kept, and not taken for saved.
		await userEvent.type(name, ' sale');
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await expect(name).toHaveValue('Autumn sale');
		// Still unsaved: Save asks for attention (it does only while there are changes).
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('th.page.save') })).toHaveClass('btn--attention')
		);
	}}
>
	{#snippet template()}
		<ThemeEditorPage
			client={createFakeLoginUiThemes({ delay: 400 })}
			id="new"
			canWrite
			{upload}
			listHref="/admin/customization/branding"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="Applied theme, saved again since"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByDisplayValue('Spring campaign');
		await waitFor(() => expect(canvas.getByText(t('th.list.pending'))).toBeVisible());
		// Nothing changed yet: nothing to save.
		await expect(canvas.getByRole('button', { name: t('th.page.save') })).toBeDisabled();
	}}
>
	{#snippet template()}
		<ThemeEditorPage
			client={createFakeLoginUiThemes({
				themes: [saved],
				active: { theme_id: 'thm_1', version: 1 }
			})}
			id="thm_1"
			canWrite
			{upload}
			listHref="/admin/customization/branding"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<ThemeEditorPage
			client={createFakeLoginUiThemes()}
			id="thm_missing"
			canWrite
			{upload}
			listHref="/admin/customization/branding"
			{oncreated}
		/>
	{/snippet}
</Story>
