<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeLaunchers } from '#lib/api/fake/launchers-fake.js';
	import { MOCK_SAML_SERVICE_PROVIDERS } from '#lib/api/fake/saml-providers-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import LauncherEditorPage from './LauncherEditorPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Launcher page',
		component: LauncherEditorPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A launcher’s page (`…/launchers/<id>`, and `…/launchers/new` to make one). The name is the title, renamed with the pencil (With an editable title); a new launcher opens with its name being entered. The preview shows the tile on the account page’s eight columns as it is edited; below it, what the launcher opens and how, how its tile looks, and who sees it. Changes wait for the save bar.'
				}
			}
		}
	});

	const oncreated = fn();
	const ondeleted = fn();
	const loadSamlProviders = async () =>
		MOCK_SAML_SERVICE_PROVIDERS.map((provider) => ({ ...provider }));
	const common = {
		loadSamlProviders,
		canWrite: true,
		listHref: '/admin/customization/launchers',
		oncreated,
		ondeleted
	};
</script>

<Story name="Link shown to everyone">
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-docs" {...common} />
	{/snippet}
</Story>

<Story name="OIDC client for groups">
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-portal" {...common} />
	{/snippet}
</Story>

<!-- IdP-initiated SAML says why it is the weaker choice; the tile carries the legacy mark. -->
<Story
	name="SAML IdP-initiated, hidden"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.field.idpTitle'));
		await expect(canvas.getByText(t('ln.preview.hidden'))).toBeInTheDocument();
		await expect(canvas.getByText(t('ln.preview.legacy'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-lms" {...common} />
	{/snippet}
</Story>

<!-- A new launcher opens with its name being entered; Done puts it in the title and the preview. -->
<Story
	name="New launcher"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const field = await canvas.findByRole('textbox', { name: t('ln.editor.name') });
		await waitFor(() => expect(field).toHaveFocus());
		await userEvent.type(field, 'Payroll{Enter}');
		await expect(
			await canvas.findByRole('heading', { level: 1, name: 'Payroll' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: t('ln.editor.editName') })).toHaveFocus();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers([])} id="new" {...common} />
	{/snippet}
</Story>

<!-- Save with what is missing: each field says so, and nothing is created. -->
<Story
	name="Saving what is incomplete"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const field = await canvas.findByRole('textbox', { name: t('ln.editor.name') });
		await userEvent.type(field, 'Payroll{Enter}');
		await userEvent.click(canvas.getByRole('radio', { name: t('ln.audience.groups') }));
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(canvas.getByRole('textbox', { name: t('ln.field.launchUrl') })).toHaveAttribute(
				'aria-invalid',
				'true'
			)
		);
		await expect(
			canvas.getAllByText(t('ln.error.groupsRequired')).some((node) => !node.closest('.toaster'))
		).toBe(true);
		await expect(oncreated).not.toHaveBeenCalled();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers([])} id="new" {...common} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="Creating a link"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const field = await canvas.findByRole('textbox', { name: t('ln.editor.name') });
		await userEvent.type(field, 'Payroll{Enter}');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('ln.field.launchUrl') }),
			'https://payroll.example.edu/'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('ln-new-1'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers([])} id="new" {...common} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.editor.readOnly'));
		await expect(canvas.queryByRole('button', { name: t('ln.editor.editName') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('ln.editor.delete') })).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-docs" {...common} canWrite={false} />
	{/snippet}
</Story>

<!-- Discard while the name is being edited: the saved name is back and its editor closes. -->
<Story
	name="Discarding while renaming"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('ln.editor.editName') }));
		const field = canvas.getByRole('textbox', { name: t('ln.editor.name') });
		await userEvent.clear(field);
		await userEvent.type(field, 'Handbook');
		await userEvent.click(await canvas.findByRole('button', { name: t('common.discard') }));
		await expect(
			await canvas.findByRole('heading', { level: 1, name: 'Documentation' })
		).toBeVisible();
		await expect(canvas.queryByRole('textbox', { name: t('ln.editor.name') })).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-docs" {...common} />
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<LauncherEditorPage client={createFakeLaunchers()} id="ln-gone" {...common} />
	{/snippet}
</Story>

<Story name="Load failed">
	{#snippet template()}
		<LauncherEditorPage
			client={createFakeLaunchers(undefined, { failLoad: true })}
			id="ln-docs"
			{...common}
		/>
	{/snippet}
</Story>
