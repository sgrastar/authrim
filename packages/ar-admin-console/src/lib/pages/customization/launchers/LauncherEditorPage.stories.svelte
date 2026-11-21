<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		FAKE_LAUNCHERS,
		FAKE_SHARED_LAUNCHERS,
		createFakeLaunchers
	} from '#lib/api/fake/launchers-fake.js';
	import { createFakePlatformLaunchers } from '#lib/api/fake/platform-launchers-fake.js';
	import { sampleTenants } from '#lib/api/fake/tenants-fake.js';
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
						'A launcher’s page (`…/launchers/<id>`, and `…/launchers/new` to make one). The name is the title, renamed with the pencil (With an editable title); a new launcher opens with its name being entered. The preview shows the tile on the account page’s eight columns as it is edited; below it, what the launcher opens and how, how its tile looks, and who sees it. Changes wait for the save bar. A tile picture chosen is uploaded on save. On the platform (`/admin/platform/customization/launchers/<id>`) a launcher is a URL link shown to everyone, with a Sharing card (every tenant, or tenants chosen in a table, and whether tenants may change it). A launcher the platform shares with a tenant says so on the tenant’s page: changing it makes the tenant’s own copy (Revert to the platform’s brings it back); when the platform allows no changes the page is read only.'
				}
			}
		}
	});

	const oncreated = fn();
	const ondeleted = fn();
	const loadSamlProviders = async () =>
		MOCK_SAML_SERVICE_PROVIDERS.map((provider) => ({ ...provider }));
	const withShared = () => createFakeLaunchers([...FAKE_LAUNCHERS, ...FAKE_SHARED_LAUNCHERS]);
	const loadTenants = async () => sampleTenants();
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

<!-- The platform's launcher: a link for everyone, with whom it is shared. -->
<Story
	name="Platform launcher shared with every tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.platform.intro'));
		await expect(canvas.getByRole('checkbox', { name: t('ln.sharing.all') })).toBeChecked();
		// Shown to everyone: no audience to choose, no application kind.
		await expect(canvas.queryByRole('radio', { name: t('ln.audience.groups') })).toBeNull();
		await expect(canvas.queryByRole('radio', { name: t('ln.app.oidc_client') })).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherEditorPage
			client={createFakePlatformLaunchers()}
			id="plc_00000000-0000-4000-8000-000000000001"
			{loadTenants}
			{...common}
			listHref="/admin/platform/customization/launchers"
		/>
	{/snippet}
</Story>

<!-- Chosen tenants are picked in a dialog with a table of the tenants. -->
<Story
	name="Platform launcher, choosing tenants"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.sharing.count', { n: 2 }));
		await userEvent.click(canvas.getByRole('button', { name: t('ln.sharing.choose') }));
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await body.findByRole('checkbox', {
				name: t('table.selectRow', { name: 'Acme (staging)' })
			})
		);
		await userEvent.click(body.getByRole('button', { name: t('tn.picker.apply', { n: 3 }) }));
		await expect(await canvas.findByText(t('ln.sharing.count', { n: 3 }))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LauncherEditorPage
			client={createFakePlatformLaunchers()}
			id="plc_00000000-0000-4000-8000-000000000002"
			{loadTenants}
			{...common}
			listHref="/admin/platform/customization/launchers"
		/>
	{/snippet}
</Story>

<!-- A launcher the platform shares and lets tenants change: the tenant's change is its copy. -->
<Story
	name="Shared launcher a tenant may change"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.shared.fromPlatform'));
		await expect(canvas.getByText(t('ln.shared.badge'))).toBeInTheDocument();
		await expect(canvas.queryByRole('button', { name: t('ln.editor.delete') })).toBeNull();
		await expect(canvas.getByRole('button', { name: t('ln.editor.editName') })).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LauncherEditorPage
			client={withShared()}
			id="plc_00000000-0000-4000-8000-000000000001"
			{...common}
		/>
	{/snippet}
</Story>

<!-- The tenant changed it and the platform changed it since: the page says so and can revert. -->
<Story
	name="Shared launcher changed by both"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.shared.platformUpdated'));
		await userEvent.click(canvas.getByRole('button', { name: t('ln.shared.revert') }));
		await expect(await canvas.findByText(t('ln.shared.fromPlatform'))).toBeInTheDocument();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<LauncherEditorPage
			client={withShared()}
			id="plc_00000000-0000-4000-8000-000000000002"
			{...common}
		/>
		<Toaster />
	{/snippet}
</Story>

<!-- The platform allows no changes: read only, and nothing to rename or delete. -->
<Story
	name="Shared launcher that cannot be changed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.shared.locked'));
		await expect(canvas.queryByRole('button', { name: t('ln.editor.editName') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('ln.editor.delete') })).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherEditorPage
			client={withShared()}
			id="plc_00000000-0000-4000-8000-000000000003"
			{...common}
		/>
	{/snippet}
</Story>
