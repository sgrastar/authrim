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
						'A saved screen’s detail page (`…/screens/<id>`): its basics and tabs — the builder (parts, the page in rows of up to three columns, the selected part’s settings), a preview, translations, where it is used and, for screens that keep response records, what people answered (shown only to admins who may view users). A built-in screen is shown, not edited: “Duplicate to edit” makes a copy. A save names the version it was made from, so another admin’s save is not overwritten. The new screen route has its own creation wizard.'
				}
			}
		}
	});

	const oncreated = fn();
	const onopen = fn();
	const common = {
		canWrite: true,
		canReadResponses: true,
		choices: schemaChoices,
		listHref: '/admin/customization/screens',
		oncreated,
		onopen
	};
	const responses = {
		screen_survey: [
			{
				id: 'r1',
				user_id: 'user_1',
				screen_key: 'welcome_survey',
				flow_id: 'flow_login',
				flow_version_id: 'v1',
				interaction_id: 'i1',
				step_id: 'survey:step',
				answers: { heard_from: 'friend', note: 'Glad to be here' },
				created_at: Date.UTC(2026, 10, 2),
				updated_at: Date.UTC(2026, 10, 2)
			}
		]
	};
</script>

<Story
	name="A survey that keeps response records"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('How did you hear about us?');
		await userEvent.click(canvas.getByRole('tab', { name: t('sc.editor.tab.responses') }));
		// A choice is shown by its label; the answer key by the part's label.
		await waitFor(() => expect(canvas.getByText('A friend')).toBeVisible());
		await expect(canvas.getByText('Glad to be here')).toBeVisible();
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS, responses })}
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
		await userEvent.click(canvas.getByRole('button', { name: t('sc.editor.save') }));
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
			id="screen_survey"
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
		// The builder is not offered: the screen is shown, not edited.
		await expect(canvas.queryByRole('tab', { name: t('sc.editor.tab.items') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('sc.editor.copyToEdit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
	}}
>
	{#snippet template()}
		<ScreenEditorPage
			{...common}
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			id="screen_login"
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
		await userEvent.click(canvas.getByRole('button', { name: t('sc.editor.save') }));
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
