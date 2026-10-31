<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { localized } from '../stories/sample';
	import KeyValueField from './KeyValueField.svelte';
	import ListField from './ListField.svelte';

	named(ListField, 'ListField');

	const { Story } = defineMeta({
		title: 'Patterns/List field',
		component: ListField,
		subcomponents: subcomponents({ KeyValueField }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'**ListField** — a list of single values: redirect URIs, allowed origins, IP ranges, domains. One box per value; Enter or “Add” opens the next box. Pasting several lines adds one entry per line. A box left empty goes away when focus leaves it. Each entry is checked with `validate` and against the others (a repeat is flagged), under the entry itself; `bind:invalid` tells the page.\n\n**KeyValueField** — pairs: request headers, claim mappings, extra parameters. Keys are monospace and unique; `validateKey` / `validateValue` add the page’s rules.\n\nBoth take `field` and are marked as a whole once they differ from the saved list.'
				}
			}
		}
	});

	const uris = () =>
		localized(['許可するオリジン', 'Allowed origins', 'Erlaubte Ursprünge', 'الأصول المسموح بها']);
	const httpsOnly = (value: string) =>
		/^https:\/\/[^/\s]+$/.test(value)
			? undefined
			: localized([
					'https:// で始まるオリジン（パスなし）を入力してください。',
					'Enter an origin starting with https:// (no path).',
					'Geben Sie einen Ursprung mit https:// ein (ohne Pfad).',
					'أدخل أصلًا يبدأ بـ https:// (دون مسار).'
				]);
</script>

<Story
	name="Values"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const first = canvas.getAllByRole('textbox')[0];
		await userEvent.click(first);
		await userEvent.clear(first);
		// Several pasted lines become several entries; a repeat is flagged on the later one.
		await userEvent.paste('https://a.example\nhttps://b.example\nhttps://a.example');
		await waitFor(() => expect(canvas.getAllByRole('textbox')).toHaveLength(4));
		await expect(canvas.getByText(t('list.duplicate'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width:520px">
			<ListField
				label={uris()}
				placeholder="https://"
				mono
				validate={httpsOnly}
				values={['https://app.example.com', 'https://admin.example.com']}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Key and value">
	{#snippet template()}
		<div style="max-width:560px">
			<KeyValueField
				label={localized([
					'追加のリクエストヘッダー',
					'Extra request headers',
					'Zusätzliche Header',
					'ترويسات إضافية'
				])}
				keyPlaceholder="X-Header-Name"
				entries={[
					{ key: 'X-Tenant', value: 'acme' },
					{ key: 'X-Region', value: 'eu' },
					{ key: 'X-Tenant', value: 'other' }
				]}
			/>
		</div>
	{/snippet}
</Story>
