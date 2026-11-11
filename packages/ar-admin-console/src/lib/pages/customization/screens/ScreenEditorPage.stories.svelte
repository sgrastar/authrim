<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { getLoginUILanguageDisplayName } from '@authrim/ar-lib-core/types/login-ui-languages';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import { demoSchemaFields, schemaChoices } from '#lib/ui/stories/screen-parts.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import ScreenEditorPage from './ScreenEditorPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Screen page',
		component: ScreenEditorPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A saved screen’s detail page (`…/screens/<id>`): its basics and tabs — the builder (parts, the page in rows of up to three columns, the selected part’s settings), a preview, translations, and where it is used. Response records and their settings are temporarily hidden. A built-in screen is shown, not edited: “Duplicate to edit” makes a copy. Changes use the Save Bar, and deletion is confirmed from the detail page. The new screen route has its own creation wizard.'
				}
			}
		}
	});

	const oncreated = fn();
	const onopen = fn();
	/** The survey with a link that leaves it by an exit of its own, drawn as a button. */
	const withExitLink = MOCK_SCREENS.map((screen) =>
		screen.id === 'screen_survey'
			? {
					...screen,
					fields: [
						...screen.fields,
						{
							field: 'link.back',
							label: 'Use a social account',
							required: false,
							block_type: 'link' as const,
							block_id: 'social',
							link_action: 'exit' as const,
							link_exit: 'social',
							link_style: 'button' as const
						}
					]
				}
			: screen
	);
	const common = {
		canWrite: true,
		canReadResponses: true,
		choices: schemaChoices,
		listHref: '/admin/customization/screens',
		oncreated,
		onopen
	};
</script>

<Story
	name="Survey response settings hidden"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('How did you hear about us?');
		await expect(canvas.queryByRole('tab', { name: t('sc.editor.tab.responses') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: /Select How did you hear/ }));
		const linked = canvas.getByRole('checkbox', { name: t('sc.set.linkDb') });
		await expect(linked).toBeChecked();
		await expect(linked).toBeDisabled();
		await expect(canvas.queryByRole('textbox', { name: t('sc.set.answerKey') })).toBeNull();
		await expect(canvas.queryByText(t('sc.set.answerTargets'))).toBeNull();
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			id="screen_survey"
			schemaFields={demoSchemaFields()}
		/>
	{/snippet}
</Story>

<!-- A link part opens a URL or leaves the screen by a way out (where it leads is the flow's). -->
<Story
	name="A link that leaves by an exit"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: /Select Use a social account/ })
		);
		const action = canvas.getByRole('combobox', { name: new RegExp(t('sc.set.linkAction')) });
		await expect(action).toHaveValue('exit');
		await expect(
			canvas.getByRole('textbox', { name: new RegExp(t('sc.set.linkExit')) })
		).toHaveValue('social');
		await expect(canvas.getByRole('radio', { name: t('sc.set.linkStyleButton') })).toBeChecked();
		// No destination on the screen: no URL, and no screen to choose.
		await expect(canvas.queryByRole('textbox', { name: t('sc.set.href') })).toBeNull();
		// Opening a URL instead: the field for it, in place of the exit's name.
		await userEvent.selectOptions(action, 'url');
		await expect(canvas.getByRole('textbox', { name: t('sc.set.href') })).toBeInTheDocument();
		await expect(
			canvas.queryByRole('textbox', { name: new RegExp(t('sc.set.linkExit')) })
		).toBeNull();
		// Back: neither.
		await userEvent.selectOptions(action, 'back');
		await expect(canvas.queryByRole('textbox', { name: t('sc.set.href') })).toBeNull();
		await expect(canvas.getByText(t('sc.set.linkActionHint.back'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: withExitLink })}
			id="screen_survey"
			schemaFields={demoSchemaFields()}
		/>
	{/snippet}
</Story>

<Story
	name="Basic information"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('sc.editor.basics') }));
		await expect(canvasElement.querySelector('fieldset.basics > .columns')).not.toBeNull();
		await expect(canvasElement.querySelector('.page-head__badges .badge')).toBeNull();
		await expect(
			canvas.getByRole('textbox', { name: new RegExp(t('sc.editor.key')) })
		).toBeDisabled();
		await expect(
			canvas.getByRole('button', {
				name: `${t('common.moreInfo')}: ${t('sc.editor.key')}`
			})
		).toBeEnabled();
		await expect(canvas.getByRole('radio', { name: t('sc.editor.canvasNarrow') })).toBeChecked();
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			id="screen_signup"
			schemaFields={demoSchemaFields()}
		/>
	{/snippet}
</Story>

<Story
	name="Localization"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('sc.editor.tab.localize') }));
		const table = await canvas.findByRole('region', { name: t('sc.editor.tab.localize') });
		const ja = getLoginUILanguageDisplayName('ja', false);
		await expect(
			within(table).getByRole('columnheader', { name: new RegExp(ja) })
		).toBeInTheDocument();
		await expect(
			within(table).getByRole('rowheader', { name: /Create your account/ })
		).toBeInTheDocument();
		const translation = within(table).getByRole('textbox', {
			name: `${t('sc.editor.name')} — ${ja}`
		});
		await userEvent.type(translation, '新規登録');
		await expect(translation).toHaveValue('新規登録');
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			id="screen_signup"
			schemaFields={demoSchemaFields()}
		/>
	{/snippet}
</Story>

<Story
	name="Another admin saved first"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('sc.editor.basics') }));
		await expect(canvasElement.querySelector('.page-head__badges .badge')).toBeNull();
		await expect(
			canvas.getByRole('textbox', { name: new RegExp(t('sc.editor.key')) })
		).toBeDisabled();
		await expect(
			canvas.getByRole('button', {
				name: `${t('common.moreInfo')}: ${t('sc.editor.key')}`
			})
		).toBeEnabled();
		const name = await canvas.findByRole('textbox', { name: new RegExp(t('sc.editor.name')) });
		await userEvent.type(name, ' (new)');
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await within(document.body).findByText(t('sc.error.conflict'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@const client = createFakeScreens({ screens: MOCK_SCREENS })}
		<ScreenEditorPage
			{...common}
			client={{
				...client,
				// Someone saved version 3 a moment ago: this page still holds version 2.
				update: (id, _version, input) => client.update(id, 99, input)
			}}
			id="screen_signup"
			schemaFields={demoSchemaFields()}
		/>
		<Toaster />
	{/snippet}
</Story>

<Story
	name="A built-in screen is duplicated to be edited"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sc.editor.systemNote'));
		await waitFor(() =>
			expect(canvasElement.querySelector('.outline')).toHaveAttribute('data-template', 'split')
		);
		const outline = canvasElement.querySelector<HTMLElement>('.outline');
		expect(outline?.querySelector('.outline__header')).toBeNull();
		expect(outline?.querySelector('.outline__footer')).toBeNull();
		expect(outline?.querySelector('.tools')).toBeNull();
		expect(outline?.style.getPropertyValue('--ol-accent')).toBe('#d36a25');
		expect(outline?.style.getPropertyValue('--ol-card')).toBe('#ffffff99');
		expect(outline?.querySelector<HTMLElement>(':scope > .outline__image')?.style.opacity).toBe(
			'0.37'
		);
		expect(
			outline?.querySelector<HTMLElement>(':scope > .outline__image > .outline__picture')?.style
				.filter
		).toBe('blur(4px) brightness(80%)');
		expect(
			outline?.querySelector<HTMLElement>('.outline__panel > .outline__image')?.style.opacity
		).toBe('0.58');
		expect(
			outline?.querySelector<HTMLElement>('.outline__card > .outline__image')?.style.opacity
		).toBe('0.42');
		await waitFor(() => expect(canvas.getByText('Sign in with Passkey')).toBeVisible());
		// The builder is not offered: the screen is shown, not edited.
		await expect(canvas.queryByRole('tab', { name: t('sc.editor.tab.items') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('sc.editor.copyToEdit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
	}}
>
	{#snippet template()}
		{@const transparentImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			id="screen_login"
			loadTheme={async () => ({
				'login-ui.template': 'split',
				'login-ui.brand_name': 'Preview brand',
				'login-ui.topbar_position': 'in_card',
				'login-ui.accent_color': '#d36a25',
				'login-ui.form_area_color': '#ffffff99',
				'login-ui.background_image_url': transparentImage,
				'login-ui.background_image_opacity': 37,
				'login-ui.background_image_filters': 'blur:4;brightness:80',
				'login-ui.brand_panel_image_url': transparentImage,
				'login-ui.brand_panel_image_opacity': 58,
				'login-ui.login_panel_background_image_url': transparentImage,
				'login-ui.login_panel_background_opacity': 42
			})}
			schemaFields={demoSchemaFields()}
		/>
	{/snippet}
</Story>

<Story
	name="Unsaved editor state"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('sc.editor.basics') }));
		const name = await canvas.findByRole('textbox', { name: new RegExp(t('sc.editor.name')) });
		await userEvent.type(name, 'Terms check');
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(t('sc.editor.key')) }),
			'terms_check'
		);
		await userEvent.click(canvas.getByRole('tab', { name: t('sc.editor.tab.items') }));
		// The palette's entry (the first button of the name; the part placed is the next).
		await userEvent.click(
			canvas.getAllByRole('button', { name: new RegExp(t('sc.part.checkbox')) })[0]
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens()}
			id="new"
			schemaFields={demoSchemaFields()}
			requiredAtSignUp={['email']}
		/>
	{/snippet}
</Story>
