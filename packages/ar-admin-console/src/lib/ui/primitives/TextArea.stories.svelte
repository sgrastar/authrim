<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import TextArea from './TextArea.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Text area',
		component: TextArea,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Multi-line text. `mono` switches to the code font and keeps left-to-right direction inside RTL pages; `actions` sit next to the label and `status` replaces the hint (JsonField uses both). `counter` shows the length at the bottom end (`120/500` with `maxlength`), amber in the last tenth — same as TextField.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<div style="max-width:520px">
			<TextArea label={sample('displayName')} hint={sample('displayNameHint')} rows={3} />
		</div>
	{/snippet}
</Story>

<Story
	name="Character count"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [field] = canvas.getAllByRole('textbox');
		await userEvent.clear(field);
		await userEvent.type(field, 'Acme');
		await expect(canvas.getByText('4/200')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width:520px;display:grid;gap:20px">
			<TextArea
				label={sample('appDescription')}
				hint={sample('appDescriptionHint')}
				value={sample('appDescriptionValue')}
				maxlength={200}
				counter
				rows={3}
			/>
			<TextArea
				label={sample('appDescription')}
				value={sample('appDescriptionValue')}
				maxlength={64}
				counter
				rows={3}
			/>
			<TextArea
				label={sample('appDescription')}
				value={sample('appDescriptionValue')}
				counter
				rows={3}
			/>
		</div>
	{/snippet}
</Story>
