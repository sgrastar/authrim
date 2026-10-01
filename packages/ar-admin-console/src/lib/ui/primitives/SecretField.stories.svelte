<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { localized } from '../stories/sample';
	import SecretField from './SecretField.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Secret field',
		component: SecretField,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Secrets: client secrets, API keys. `mode="show"` shows a value the console just created, hidden until “Show”, copyable either way; `once` says it cannot be shown again. `mode="enter"` takes a secret the admin types, hidden while typing. With `stored`, a secret already exists and is never sent back: the field reads “Set” until the admin chooses to replace it, and `value` stays empty unless a new one is typed — saving without touching it keeps the old secret. The hidden form is a fixed row of dots, so the length is not revealed.'
				}
			}
		}
	});

	const secret = () =>
		localized(['クライアントシークレット', 'Client secret', 'Client-Geheimnis', 'سر العميل']);
</script>

<Story name="Shown once">
	{#snippet template()}
		<div style="max-width:560px">
			<SecretField
				label={secret()}
				mode="show"
				once
				value="demo_secret_for_storybook_only"
			/>
		</div>
	{/snippet}
</Story>

<Story name="Enter">
	{#snippet template()}
		<div style="max-width:480px"><SecretField label={secret()} /></div>
	{/snippet}
</Story>

<Story
	name="Already set"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(t('secret.stored'))).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('secret.replace') }));
		await waitFor(() => expect(canvasElement.querySelector('input[type=password]')).toHaveFocus());
		await userEvent.click(canvas.getByRole('button', { name: t('secret.keep') }));
		await waitFor(() => expect(canvas.getByText(t('secret.stored'))).toBeInTheDocument());
	}}
>
	{#snippet template()}
		<div style="max-width:480px"><SecretField label={secret()} stored /></div>
	{/snippet}
</Story>
