<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
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
						'A screen’s page (`…/screens/new`, `…/screens/<id>`): its basics, then tabs — the builder (parts, the page in rows of up to three columns, the selected part’s settings), a preview, the translations into the Login UI’s languages, where it is used and, for a screen that keeps response records, what signed-in people answered (shown to those who may view users). A built-in screen is shown, not edited: “Duplicate to edit” makes a copy, which can be reset to it later. A save names the version it was made from: another admin’s save since is reported, not overwritten.'
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
	name="Another admin saved first"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
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
	name="New screen"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: new RegExp(t('sc.editor.name')) });
		await userEvent.type(name, 'Terms check');
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(t('sc.editor.key')) }),
			'terms_check'
		);
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
