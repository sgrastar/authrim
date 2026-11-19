<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import TenantDeletedNotice from './TenantDeletedNotice.svelte';

	const { Story } = defineMeta({
		title: 'Components/TenantDeletedNotice',
		component: TenantDeletedNotice,
		tags: ['autodocs'],
		args: { canRemove: true, onRemoveChosen: fn(async () => 'signalled' as const) },
		parameters: {
			docs: {
				description: {
					component:
						'Shown in place of the sign-in or sign-up form when the platform says the tenant of this host was deleted. It says so, and helps clear the passkeys the browser still holds for this host: passkeys of people remembered in this browser are reported without asking (`removedAutomatically`), and the button lets the person pick one that is still saved. Where the browser cannot report passkeys (`canRemove` false) only the manual advice is shown.'
				}
			}
		}
	});
</script>

<Story name="Passkey can be picked">
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width:420px">
				<TenantDeletedNotice {...args} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Removed automatically" args={{ removedAutomatically: true }}>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width:420px">
				<TenantDeletedNotice {...args} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Browser cannot remove passkeys" args={{ canRemove: false }}>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width:420px">
				<TenantDeletedNotice {...args} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Picking a passkey reports it"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		expect(canvas.queryAllByRole('alert')).toHaveLength(0);
		await userEvent.click(canvas.getByRole('button'));
		await waitFor(() => expect(canvas.getAllByRole('alert')).toHaveLength(1));
		expect(args.onRemoveChosen).toHaveBeenCalledTimes(1);
	}}
>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width:420px">
				<TenantDeletedNotice {...args} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="A cancelled pick reports nothing"
	args={{ onRemoveChosen: fn(async () => 'cancelled' as const) }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button'));
		await waitFor(() => expect(args.onRemoveChosen).toHaveBeenCalledTimes(1));
		expect(canvas.queryAllByRole('alert')).toHaveLength(0);
	}}
>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width:420px">
				<TenantDeletedNotice {...args} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>
