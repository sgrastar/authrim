<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Alert from './Alert.svelte';

	const { Story } = defineMeta({
		title: 'Components/Alert',
		component: Alert,
		tags: ['autodocs'],
		args: { onDismiss: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Inline message above the actions of a card. `error` for failures, `warning` for recoverable provider problems, `success` for confirmations, `info` for notices. Dismissible alerts hide themselves and call `onDismiss`.'
				}
			}
		}
	});
</script>

<Story name="Variants">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:grid;gap:12px;max-width:420px">
				<Alert variant="error" title="Sign-in failed">The code is not correct.</Alert>
				<Alert variant="warning" title="Provider unavailable">Try another way to sign in.</Alert>
				<Alert variant="success">A new code has been sent.</Alert>
				<Alert variant="info">Your directory account will move to a passkey.</Alert>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Dismiss"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button'));
		await expect(args.onDismiss).toHaveBeenCalledOnce();
		await expect(canvas.queryByRole('alert')).toBeNull();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame
			><div style="max-width:420px">
				<Alert variant="error" dismissible onDismiss={args.onDismiss}
					>The code is not correct.</Alert
				>
			</div></LoginUIFrame
		>
	{/snippet}
</Story>
