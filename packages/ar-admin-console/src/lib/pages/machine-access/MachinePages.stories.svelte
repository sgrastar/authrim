<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { machineAccess } from '#lib/access/access.js';
	import { fakeMachineAccess } from '#lib/api/fake/machine-access-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import MachineDetailPage from './MachineDetailPage.svelte';
	import MachineListPage from './MachineListPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Platform/Machine access',
		component: MachineListPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Platform → Administrators → Machine access (`/admin/platform/admins/machine`, `/api/admin/machine-access`): machines that sign in to the Admin API with their own key (private_key_jwt); Authrim keeps only the public key. The list shows name, client ID, type, status and working keys; "New" asks for a name, a client ID, permissions and tenant reach, with description, type and token lifetime under "Advanced settings". A machine’s page shows its state, permissions, tenants and keys; adding a key asks for the key ID and a pasted public JWK (a private member such as `d` is refused before anything is sent), with algorithm, name and expiry folded. Handing out access (create, permissions, tenants, enable, add key) may ask for step-up (`machine.permission.grant`). Reading needs `admin:machine_access:read`, changing `…:write`, disabling and revoking `…:delete`.'
				}
			}
		}
	});

	const platform = machineAccess({
		platform: true,
		roles: [],
		permissions: [
			'admin:machine_access:read',
			'admin:machine_access:write',
			'admin:machine_access:delete'
		]
	});
	const tenants = [
		{ id: 'default', name: 'Default' },
		{ id: 'acme', name: 'Acme' }
	];
	const onopen = fn();
	const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('CI deployer');
		await expect(canvas.getByRole('button', { name: t('mc.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		<MachineListPage
			client={fakeMachineAccess({ delay: 100 })}
			access={platform}
			{tenants}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Empty"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('mc.list.empty'));
	}}
>
	{#snippet template()}
		<MachineListPage
			client={fakeMachineAccess({ principals: [] })}
			access={platform}
			{tenants}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Create"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(within(dialog).getByLabelText(new RegExp(t('mc.f.name'))), 'Nightly job');
		await expect(within(dialog).getByLabelText(new RegExp(t('mc.f.clientId')))).toHaveValue(
			'nightly-job'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.new.submit') }));
		await waitFor(() => expect(onopen).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<MachineListPage client={fakeMachineAccess()} access={platform} {tenants} {onopen} />
	{/snippet}
</Story>

<Story
	name="Client ID follows a pasted name"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.click(within(dialog).getByLabelText(new RegExp(t('mc.f.name'))));
		await userEvent.paste('Weekly export');
		await expect(within(dialog).getByLabelText(new RegExp(t('mc.f.clientId')))).toHaveValue(
			'weekly-export'
		);
	}}
>
	{#snippet template()}
		<MachineListPage client={fakeMachineAccess()} access={platform} {tenants} {onopen} />
	{/snippet}
</Story>

<Story
	name="Permission refused"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.create') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(within(dialog).getByLabelText(new RegExp(t('mc.f.name'))), 'Nightly job');
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.f.permissionAdd') }));
		await userEvent.type(within(dialog).getByPlaceholderText('admin:users:read'), '*');
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.new.submit') }));
		await within(dialog).findByText(t('mc.error.invalid'));
	}}
>
	{#snippet template()}
		<MachineListPage
			client={fakeMachineAccess({ refuseGrant: true })}
			access={platform}
			{tenants}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="A machine"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'CI deployer' });
		await canvas.findByText('ci-2026-11');
		await canvas.findByText(t('mc.key.status.notYet'));
		await canvas.findByText('admin:settings:write');
	}}
>
	{#snippet template()}
		<MachineDetailPage
			client={fakeMachineAccess({ delay: 100 })}
			principalId="amp_ci"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>

<Story
	name="Add a key with a private member"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.key.add') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.kid')))),
			'new-key'
		);
		await userEvent.click(within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.jwk')))));
		await userEvent.paste('{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"secret"}');
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.key.new.submit') }));
		await within(dialog).findByText(t('mc.key.jwk.private'));
	}}
>
	{#snippet template()}
		<MachineDetailPage
			client={fakeMachineAccess()}
			principalId="amp_ci"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>

<Story
	name="Add a key"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.key.add') }));
		const dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.kid')))),
			'new-key'
		);
		await userEvent.click(within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.jwk')))));
		await userEvent.paste('{"kty":"EC","crv":"P-256","x":"a","y":"b"}');
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.key.new.submit') }));
		await canvas.findByText('new-key');
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<MachineDetailPage
			client={fakeMachineAccess()}
			principalId="amp_ci"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>

<Story
	name="Add a key after a cancelled invalid entry"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.key.add') }));
		let dialog = await body.findByRole('dialog');
		await userEvent.click(within(dialog).getByText(t('mc.advanced')));
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.days')))),
			'abc'
		);
		await userEvent.tab();
		await userEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
		await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.key.add') }));
		dialog = await body.findByRole('dialog');
		await userEvent.type(
			within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.kid')))),
			'again'
		);
		await userEvent.click(within(dialog).getByLabelText(new RegExp(escapeRe(t('mc.key.jwk')))));
		await userEvent.paste('{"kty":"EC","crv":"P-256","x":"a","y":"b"}');
		await userEvent.click(within(dialog).getByRole('button', { name: t('mc.key.new.submit') }));
		await canvas.findByText('again');
	}}
>
	{#snippet template()}
		<Toaster />
		<MachineDetailPage
			client={fakeMachineAccess()}
			principalId="amp_ci"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>

<Story
	name="A disabled machine"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('mc.d.disabledNote'));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('mc.d.enable') })).toBeVisible()
		);
	}}
>
	{#snippet template()}
		<MachineDetailPage
			client={fakeMachineAccess()}
			principalId="amp_sync"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>

<Story
	name="A deleted machine"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('mc.d.deletedNote'));
		await canvas.findByText('old-key');
		for (const label of [
			'mc.d.enable',
			'mc.d.disable',
			'mc.d.edit',
			'mc.key.add',
			'mc.key.revoke'
		]) {
			await expect(canvas.queryByRole('button', { name: t(label as never) })).toBeNull();
		}
	}}
>
	{#snippet template()}
		<MachineDetailPage
			client={fakeMachineAccess()}
			principalId="amp_gone"
			access={platform}
			{tenants}
			listHref="#machines"
		/>
	{/snippet}
</Story>
