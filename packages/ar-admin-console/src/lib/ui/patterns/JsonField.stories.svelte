<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import JsonField from './JsonField.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/JSON field',
		component: JsonField,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Paste-in JSON (metadata, claim mappings, policies). Checked as you type with the line and column of the first error; **Format** re-indents valid input. `parsed` binds to the value while the text is valid.'
				}
			}
		}
	});

	const VALID =
		'{"entityID":"https://idp.example.com","sso":{"binding":"redirect","url":"https://idp.example.com/sso"}}';
	const INVALID =
		'{\n  "entityID": "https://idp.example.com",\n  "sso": {\n    "binding": "redirect",\n  }\n}';
</script>

<Story
	name="Valid"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button'));
		await waitFor(() =>
			expect(canvas.getByRole('textbox')).toHaveValue(
				JSON.stringify(JSON.parse(VALID), null, 2) + '\n'
			)
		);
	}}
>
	{#snippet template()}
		<div style="max-width:560px">
			<JsonField label={sample('samlMetadata')} hint={sample('jsonHint')} value={VALID} />
		</div>
	{/snippet}
</Story>

<Story name="Invalid">
	{#snippet template()}
		<div style="max-width:560px">
			<JsonField label={sample('samlMetadata')} hint={sample('jsonHint')} value={INVALID} />
		</div>
	{/snippet}
</Story>

<Story name="Empty">
	{#snippet template()}
		<div style="max-width:560px">
			<JsonField label={sample('samlMetadata')} hint={sample('jsonHint')} required />
		</div>
	{/snippet}
</Story>
