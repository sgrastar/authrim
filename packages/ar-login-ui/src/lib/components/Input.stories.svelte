<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Input from './Input.svelte';

	const { Story } = defineMeta({
		title: 'Components/Input',
		component: Input,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						"Labelled text input of the legacy method layout and signup's fallback fields. An `error` replaces the `helperText` and sets `aria-invalid`."
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="States">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:grid;gap:16px;max-width:380px">
				<Input label={$LL.common_email()} placeholder={$LL.common_emailPlaceholder()} />
				<Input
					label={$LL.common_email()}
					value="ada@example.com"
					helperText="We only use this to send you a code."
				/>
				<Input
					label={$LL.common_email()}
					value="not-an-email"
					error="Enter a valid email address."
				/>
				<Input label={$LL.common_email()} value="ada@example.com" disabled />
				<Input label={$LL.login_directoryPasswordLabel()} type="password" value="secret" />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Typing"
	play={async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole('textbox');
		await userEvent.type(input, 'ada@example.com');
		await expect(input).toHaveValue('ada@example.com');
	}}
>
	{#snippet template()}
		<LoginUIFrame><div style="max-width:380px"><Input label="Email" /></div></LoginUIFrame>
	{/snippet}
</Story>
