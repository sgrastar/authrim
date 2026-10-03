<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import PinCodeInput from './PinCodeInput.svelte';

	const { Story } = defineMeta({
		title: 'Components/PinCodeInput',
		component: PinCodeInput,
		tags: ['autodocs'],
		args: { onValueChange: fn(), label: 'Code', length: 6 },
		parameters: {
			docs: {
				description: {
					component:
						'One-time code entry: a single native input (so autofill, paste and screen readers work) drawn as separate cells. Only digits are accepted; the length is 6 or 8.'
				}
			}
		}
	});
</script>

<Story name="Lengths and states">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:grid;gap:18px;max-width:380px">
				<PinCodeInput label="Empty" />
				<PinCodeInput label="Partly filled" value="123" />
				<PinCodeInput label="Eight digits" length={8} value="1234" />
				<PinCodeInput label="Disabled" value="123456" disabled />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Typing"
	play={async ({ canvasElement, args }) => {
		const input = within(canvasElement).getByRole('textbox');
		await userEvent.type(input, '12a34');
		await expect(args.onValueChange).toHaveBeenLastCalledWith('1234');
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><div style="max-width:380px"><PinCodeInput {...args} /></div></LoginUIFrame>
	{/snippet}
</Story>
