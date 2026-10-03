<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import CibaView, { type CibaRequest } from './CibaView.svelte';

	const NOW = 1_800_000_000;

	const { Story } = defineMeta({
		title: 'Screens/CIBA',
		component: CibaView,
		tags: ['autodocs'],
		args: {
			loading: false,
			requests: [],
			now: NOW,
			onApprove: fn(),
			onDeny: fn(),
			onRefresh: fn(),
			onDismissError: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Backchannel (CIBA) requests an application made on the person’s behalf, each to approve or deny. The route (`src/routes/ciba`) loads the requests and ticks the clock; this view draws them in theme colours.'
				}
			}
		}
	});

	const request = (overrides: Partial<CibaRequest> = {}): CibaRequest => ({
		auth_req_id: 'req-1',
		client_id: 'bank-app',
		client_name: 'Acme Bank',
		client_logo_uri: null,
		scope: 'openid profile payments',
		created_at: NOW - 30,
		expires_at: NOW + 245,
		...overrides
	});
</script>

{#snippet page(args: Parameters<typeof CibaView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell wide><CibaView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Loading" args={{ loading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="No pending requests">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="A request to compare"
	args={{
		requests: [
			request({ binding_message: 'Transfer ¥12,000 to Taro Yamada', user_code: 'K7Q-29X' })
		]
	}}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('4:05')).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: /approve|承認/i }));
		await expect(args.onApprove).toHaveBeenCalledWith('req-1');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Several requests"
	args={{
		requests: [
			request({ binding_message: 'Sign in on the kiosk' }),
			request({
				auth_req_id: 'req-2',
				client_name: 'Acme Payroll',
				scope: 'openid payroll:read',
				expires_at: NOW + 59
			})
		]
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Approving" args={{ requests: [request()], processingId: 'req-1' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Expired" args={{ requests: [request({ expires_at: NOW - 1 })] }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Failed to load" args={{ error: 'Failed to load pending requests', requests: [] }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Approved" args={{ successMessage: 'Request approved' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
