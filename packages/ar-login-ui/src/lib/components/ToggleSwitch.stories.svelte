<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import ToggleSwitch from './ToggleSwitch.svelte';

	const { Story } = defineMeta({
		title: 'Components/ToggleSwitch',
		component: ToggleSwitch,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'On/off switch with an optional label and description. Used by the account page.'
				}
			}
		}
	});
</script>

<Story name="Sizes and states">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:grid;gap:14px">
				<ToggleSwitch label="Medium" checked />
				<ToggleSwitch label="Small" size="sm" />
				<ToggleSwitch
					label="Large"
					size="lg"
					description="With a description under the label."
					checked
				/>
				<ToggleSwitch label="Disabled" disabled />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Toggling"
	play={async ({ canvasElement }) => {
		const toggle = within(canvasElement).getByRole('switch');
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await userEvent.click(toggle);
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
	}}
>
	{#snippet template()}
		<LoginUIFrame><ToggleSwitch label="Notify me" /></LoginUIFrame>
	{/snippet}
</Story>
