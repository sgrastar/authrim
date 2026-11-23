<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { ipAllowlistAccess } from '#lib/access/access.js';
	import { fakeIpAllowlist } from '#lib/api/fake/admin-ip-allowlist-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import IpAllowlistPage from './IpAllowlistPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/IP limit',
		component: IpAllowlistPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrator IP limit (`/admin/settings/team-ip-allowlist`, `/api/admin/ip-allowlist`): the addresses and ranges the tenant’s administrators may use to reach the admin console and the Admin API. It is not a list for end users’ sign-in. With no enabled entry every address is let in; with one, only addresses in an enabled range are. Only IPv4 is added here: one address or a CIDR range (`203.0.113.0/24`, kept from its first address). The page shows the address the administrator is on and whether it gets in, says under the field what a range covers and whether it includes that address, and holds a change that would leave it outside (the first entry, switching off or deleting the range that held it, changing a range) for a confirmation. Reading needs `admin:ip_allowlist:read`; adding, changing and switching on and off `…:write`; deleting `…:delete` too.'
				}
			}
		}
	});

	const everything = ipAllowlistAccess({
		platform: false,
		roles: [],
		permissions: ['admin:ip_allowlist:*']
	});
	const readOnly = ipAllowlistAccess({
		platform: false,
		roles: [],
		permissions: ['admin:ip_allowlist:read']
	});

	const label = (key: Parameters<typeof t>[0]) => new RegExp(t(key).replace(/[()]/g, '\\$&'));
</script>

<Story
	name="Limit on, your address allowed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.status.active.title'));
		await expect(canvas.getByText('203.0.113.5')).toBeVisible();
		await expect(canvas.getByText(t('ip.mine'))).toBeVisible();
		await expect(canvas.getByText(t('ip.size.range', { count: '256' }))).toBeVisible();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ delay: 100 })} access={everything} />
	{/snippet}
</Story>

<Story
	name="No limit set"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.status.open.title'));
		await expect(canvas.getByText(t('ip.empty.title'))).toBeVisible();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ entries: [] })} access={everything} />
	{/snippet}
</Story>

<Story
	name="Your address is not covered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.status.active.title'));
		await expect(canvas.getByText(t('ip.you.blocked'))).toBeVisible();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ currentIp: '192.0.2.99' })} access={everything} />
	{/snippet}
</Story>

<Story
	name="Your address is IPv6"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.you.ipv6'));
		await expect(canvas.getByText(t('ip.you.blocked'))).toBeVisible();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ currentIp: '2001:db8::7' })} access={everything} />
	{/snippet}
</Story>

<Story
	name="Add your own address"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ip.status.open.title'));
		await userEvent.click(canvas.getByRole('button', { name: t('ip.add') }));
		await userEvent.click(await body.findByRole('button', { name: label('ip.useMine') }));
		await body.findByText(t('ip.preview.mine'));
		await userEvent.click(body.getByRole('button', { name: t('ip.new.submit') }));
		await body.findByText(t('ip.toast.added'));
		await canvas.findByText(t('ip.status.active.title'));
		await expect(canvas.getByText(t('ip.you.allowed'))).toBeVisible();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<IpAllowlistPage client={fakeIpAllowlist({ entries: [] })} access={everything} />
	{/snippet}
</Story>

<Story
	name="A first entry that leaves you outside"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await canvas.findByText(t('ip.status.open.title'));
		await userEvent.click(canvas.getByRole('button', { name: t('ip.add') }));
		await userEvent.type(await body.findByLabelText(label('ip.field.range')), '198.51.100.0/24');
		await body.findByText(t('ip.preview.notMine'));
		await userEvent.click(body.getByRole('button', { name: t('ip.new.submit') }));
		// Held: nothing was added until the administrator accepts being locked out.
		await body.findByText(t('ip.lock.title'));
		await expect(body.getByText(t('ip.lock.confirm'))).toBeVisible();
		await expect(canvas.queryByText('198.51.100.0/24')).toBeNull();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ entries: [] })} access={everything} />
	{/snippet}
</Story>

<Story
	name="Typing a range"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await canvas.findByText(t('ip.status.active.title'));
		await userEvent.click(canvas.getByRole('button', { name: t('ip.add') }));
		const field = await body.findByLabelText(label('ip.field.range'));
		// A range is kept from its first address.
		await userEvent.type(field, '192.168.1.77/24');
		await body.findByText(t('ip.preview.normalized', { range: '192.168.1.0/24' }), {
			exact: false
		});
		await userEvent.clear(field);
		await userEvent.type(field, '999.1.1.1');
		await body.findByText(t('ip.err.address'));
		await userEvent.clear(field);
		await userEvent.type(field, '2001:db8::1');
		await body.findByText(t('ip.err.ipv6'));
		await userEvent.clear(field);
		await userEvent.type(field, '198.51.100.17');
		await body.findByText(t('ip.err.duplicate'));
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist()} access={everything} />
	{/snippet}
</Story>

<Story
	name="Switch off the range that holds you"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await canvas.findByText(t('ip.status.active.title'));
		await userEvent.click(
			canvas.getByRole('button', { name: t('ip.col.actionsFor', { range: '203.0.113.0/24' }) })
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('ip.action.disable') }));
		await body.findByText(t('ip.lock.title'));
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist()} access={everything} />
	{/snippet}
</Story>

<Story
	name="Delete the last range"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ip.status.active.title'));
		await userEvent.click(
			canvas.getByRole('button', { name: t('ip.col.actionsFor', { range: '203.0.113.5' }) })
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('ip.action.delete') }));
		await body.findByText(label('ip.delete.last'));
		await userEvent.click(body.getByRole('button', { name: t('ip.delete.confirm') }));
		await body.findByText(t('ip.toast.deleted'));
		await canvas.findByText(t('ip.status.open.title'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<IpAllowlistPage
			client={fakeIpAllowlist({
				entries: [
					{
						id: 'only',
						ip_range: '203.0.113.5',
						ip_version: 4,
						description: 'Me',
						enabled: true,
						created_at: 1_760_000_000_000,
						updated_at: 1_760_000_000_000
					}
				]
			})}
			access={everything}
		/>
	{/snippet}
</Story>

<Story
	name="Deleted by someone else while editing"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ip.status.active.title'));
		await userEvent.click(
			canvas.getByRole('button', { name: t('ip.col.actionsFor', { range: '198.51.100.17' }) })
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('ip.action.edit') }));
		await userEvent.click(await body.findByRole('button', { name: t('ip.edit.submit') }));
		await body.findByText(t('ip.err.notFound'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<IpAllowlistPage client={fakeIpAllowlist({ failOn: { update: 404 } })} access={everything} />
	{/snippet}
</Story>

<Story
	name="Check an address"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await canvas.findByText(t('ip.status.active.title'));
		await userEvent.click(canvas.getByRole('button', { name: t('ip.check') }));
		const field = await body.findByLabelText(t('ip.check.field'));
		await userEvent.clear(field);
		await userEvent.type(field, '198.51.100.17');
		await userEvent.click(body.getByRole('button', { name: t('ip.check.submit') }));
		await body.findByText(t('ip.check.allowed', { ip: '198.51.100.17' }));
		await userEvent.clear(field);
		await userEvent.type(field, '192.0.2.1');
		await userEvent.click(body.getByRole('button', { name: t('ip.check.submit') }));
		await body.findByText(t('ip.check.blocked', { ip: '192.0.2.1' }));
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist()} access={readOnly} />
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.status.active.title'));
		await expect(canvas.queryByRole('button', { name: t('ip.add') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: /203\.0\.113\.0\/24/ })).toBeNull();
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist()} access={readOnly} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ip.noAccess'));
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ failOn: { list: 403 } })} access={readOnly} />
	{/snippet}
</Story>

<Story
	name="Could not load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ip.loadFailed'));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('common.retry') })).toBeVisible()
		);
	}}
>
	{#snippet template()}
		<IpAllowlistPage client={fakeIpAllowlist({ failOn: { list: 500 } })} access={everything} />
	{/snippet}
</Story>
