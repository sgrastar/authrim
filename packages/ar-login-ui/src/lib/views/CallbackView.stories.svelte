<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { LL } from '$i18n/i18n-svelte';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import CallbackView from './CallbackView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Sign-in callback',
		component: CallbackView,
		tags: ['autodocs'],
		args: { status: 'processing', onRetry: fn() },
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Where a sign-in through another service (single sign-on, an external IdP) comes back. The route (`src/routes/callback`) finishes the handoff and any provisioning; this view draws its status.'
				}
			}
		}
	});
</script>

{#snippet page(args: Parameters<typeof CallbackView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><CallbackView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Finishing the sign-in">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Signed in" args={{ status: 'success' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Failed"
	args={{
		status: 'error',
		errorCode: 'access_denied',
		errorMessage: 'You denied the request, so the sign-in was not completed.'
	}}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('access_denied')).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: get(LL).common_backToLogin() }));
		await expect(args.onRetry).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
