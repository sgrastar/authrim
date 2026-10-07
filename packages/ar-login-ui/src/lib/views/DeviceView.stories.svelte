<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { LL } from '$i18n/i18n-svelte';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import DeviceView from './DeviceView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Device code',
		component: DeviceView,
		tags: ['autodocs'],
		args: {
			step: 'input',
			userCode: '',
			onCodeInput: fn(),
			onKeyPress: fn(),
			onVerify: fn(),
			onApprove: fn(),
			onDeny: fn(),
			onDismissError: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Where a person types the code shown on a TV or command line, then approves or denies the device. The route (`src/routes/device`) owns the requests; this view draws the step it is given.'
				}
			}
		}
	});

	const info = {
		client_name: 'Acme TV',
		client_uri: 'https://example.com/tv',
		scopes: ['openid', 'profile', 'email']
	};
</script>

{#snippet page(args: Parameters<typeof DeviceView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><DeviceView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Enter the code">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Code complete" args={{ userCode: 'ABCD-1234' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Verifying" args={{ userCode: 'ABCD-1234', verifying: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Wrong code"
	args={{ userCode: 'ABCD-123', error: 'The code is invalid or has expired.' }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Approve or deny" args={{ step: 'verified', userCode: 'ABCD-1234', deviceInfo: info }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Approving"
	args={{ step: 'verified', userCode: 'ABCD-1234', deviceInfo: info, loading: true }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Approved"
	args={{
		step: 'verified',
		userCode: 'ABCD-1234',
		deviceInfo: info,
		success: 'The device is approved. You can return to it.'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Access withdrawn: start again"
	args={{ error: get(LL).device_errorConsentWithdrawn() }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		// Approval was refused because the code predates a withdrawal: back at code entry, empty.
		await expect(canvas.getByRole('alert')).toHaveTextContent(args.error!);
		await expect(canvas.getByRole('textbox')).toHaveValue('');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Not saved: try again"
	args={{
		step: 'verified',
		userCode: 'ABCD-1234',
		deviceInfo: info,
		error: get(LL).device_errorTryAgain()
	}}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		// Nothing changed on the server, so the same code can be approved again.
		await expect(canvas.getByRole('alert')).toHaveTextContent(args.error!);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).device_approveButton() }));
		await expect(args.onApprove).toHaveBeenCalledOnce();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Outcome not confirmed"
	args={{
		step: 'verified',
		userCode: 'ABCD-1234',
		deviceInfo: info,
		error: get(LL).device_errorOutcomeUnknown()
	}}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		// The answer to the decision was lost and the re-check failed too: no success is claimed.
		await expect(canvas.getByRole('alert')).toHaveTextContent(args.error!);
		await expect(canvas.queryByText(get(LL).device_success())).toBeNull();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Too many attempts"
	args={{ userCode: 'ABCD-1234', error: get(LL).device_errorTooManyAttempts() }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Verify when the code is complete"
	args={{ userCode: 'ABCD-1234' }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button').at(-1)!);
		await expect(args.onVerify).toHaveBeenCalledOnce();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
