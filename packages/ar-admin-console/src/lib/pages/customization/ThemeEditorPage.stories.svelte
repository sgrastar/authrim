<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeLoginUiThemes } from '#lib/api/fake/login-ui-themes-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ThemeEditorPage from './ThemeEditorPage.svelte';
	import { draftToValues, valuesToDraft } from './theme-values';
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
						'A theme’s page (`…/branding/new`, `…/branding/<id>`). The console’s header carries the way back to the list, an editable theme name, whether it is applied, and Save and Apply. The name is edited in place with Done and Cancel; the theme editor fills the rest. Images chosen in the editor are uploaded on Save. A theme with unsaved changes is not applied: save first, so that what is applied is what was saved.'
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
	const colorClient = createFakeLoginUiThemes({ themes: [saved] });
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
	name="Rename in place"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Spring campaign' });
		const edit = canvas.getByRole('button', { name: t('th.page.editName') });
		await userEvent.click(edit);
		const name = canvas.getByRole('textbox', { name: t('th.page.name') });
		await expect(name).toHaveValue('Spring campaign');
		await expect(name).toHaveFocus();
		await userEvent.clear(name);
		await userEvent.type(name, 'Temporary name');
		await userEvent.click(canvas.getByRole('button', { name: t('common.cancel') }));
		await expect(canvas.getByRole('heading', { name: 'Spring campaign' })).toBeVisible();
		await expect(canvas.getByRole('button', { name: t('th.page.editName') })).toHaveFocus();
		await expect(canvas.getByRole('button', { name: t('th.page.save') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.editName') }));
		await userEvent.clear(canvas.getByRole('textbox', { name: t('th.page.name') }));
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.nameDone') }));
		await expect(canvas.getByText(t('th.page.nameRequired'))).toBeVisible();
		await userEvent.type(canvas.getByRole('textbox', { name: t('th.page.name') }), 'Late spring');
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.nameDone') }));
		await expect(canvas.getByRole('heading', { name: 'Late spring' })).toBeVisible();
		await expect(canvas.queryByRole('textbox', { name: t('th.page.name') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('th.page.save') })).toBeDisabled()
		);
	}}
>
	{#snippet template()}
		<ThemeEditorPage
			client={createFakeLoginUiThemes({ themes: [saved] })}
			id="thm_1"
			canWrite
			{upload}
			listHref="/admin/customization/branding"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="Bar, brand and topbar control colours survive save"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Spring campaign' });
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const colors = [
			[t('th.c.brandPanelBackground'), '#090d1e'],
			[t('th.c.themeToggleBackground'), '#111111'],
			[t('th.c.languageSelectBackground'), '#eeeeee'],
			[t('th.c.headerBackground'), '#112233'],
			[t('th.c.headerText'), '#fefefe'],
			[t('th.c.footerBackground'), '#445566'],
			[t('th.c.footerText'), '#eeeeee']
		] as const;
		for (const [label, value] of colors) {
			await userEvent.type(canvas.getByRole('textbox', { name: label }), value);
		}
		fireEvent.input(
			canvas.getByRole('slider', {
				name: t('color.opacity', { name: t('th.c.brandPanelBackground') })
			}),
			{ target: { value: '38' } }
		);
		const save = canvas.getByRole('button', { name: t('th.page.save') });
		await expect(save).toBeEnabled();
		await userEvent.click(save);
		await waitFor(() => expect(save).toBeDisabled());
		const light = (await colorClient.get('thm_1')).theme.values;
		await expect(light).toMatchObject({
			'login-ui.brand_panel_background_color': '#090d1e61',
			'login-ui.theme_toggle_background_color': '#111111',
			'login-ui.language_select_background_color': '#eeeeee',
			'login-ui.header_background_color': '#112233',
			'login-ui.header_text_color': '#fefefe',
			'login-ui.footer_background_color': '#445566',
			'login-ui.footer_text_color': '#eeeeee'
		});
		await expect(valuesToDraft(light)).toMatchObject({
			brandPanelBackground: '#090d1e61',
			themeToggleBackground: '#111111',
			languageSelectBackground: '#eeeeee',
			headerBackground: '#112233',
			headerText: '#fefefe',
			footerBackground: '#445566',
			footerText: '#eeeeee'
		});
		await userEvent.click(canvas.getByRole('tab', { name: t('th.mode.dark') }));
		for (const [label, value] of [
			[t('th.c.brandPanelBackground'), '#010203'],
			[t('th.c.themeToggleBackground'), '#f5f5f5'],
			[t('th.c.languageSelectBackground'), '#222222'],
			[t('th.c.headerBackground'), '#0a0b0c'],
			[t('th.c.headerText'), '#fafafa'],
			[t('th.c.footerBackground'), '#141516'],
			[t('th.c.footerText'), '#dedede']
		] as const) {
			await userEvent.type(canvas.getByRole('textbox', { name: label }), value);
		}
		fireEvent.input(
			canvas.getByRole('slider', {
				name: t('color.opacity', { name: t('th.c.brandPanelBackground') })
			}),
			{ target: { value: '50' } }
		);
		await userEvent.click(save);
		await waitFor(() => expect(save).toBeDisabled());
		const dark = (await colorClient.get('thm_1')).theme.values;
		await expect(JSON.parse(dark['login-ui.dark_colors'] as string)).toMatchObject({
			brand_panel_background: '#01020380',
			theme_toggle_background: '#f5f5f5',
			language_select_background: '#222222',
			header_background: '#0a0b0c',
			header_text: '#fafafa',
			footer_background: '#141516',
			footer_text: '#dedede'
		});
	}}
>
	{#snippet template()}
		<ThemeEditorPage
			client={colorClient}
			id="thm_1"
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
		await canvas.findByRole('heading', { name: 'Spring campaign' });
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
