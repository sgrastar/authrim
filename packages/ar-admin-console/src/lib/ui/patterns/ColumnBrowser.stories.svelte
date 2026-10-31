<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import ColumnBrowserDemo from '../stories/ColumnBrowserDemo.svelte';
	import ColumnBrowser from './ColumnBrowser.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Column browser',
		component: ColumnBrowser,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Pick one template from a catalogue in three columns — categories with counts, the items of the chosen category, and the chosen item’s detail (a snippet: description, version, actions). Ported from the legacy Admin UI destination template browser (e.g. SAML attribute profiles such as GakuNin). Stacks vertically on narrow screens.'
				}
			}
		}
	});
</script>

<Story
	name="SAML attribute templates"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /Switch edu-ID/ }));
		await expect(
			canvas.getByText('Core SAML attributes from the Switch edu-ID federation specification.')
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: /GakuNin/ }));
	}}
>
	{#snippet template()}<ColumnBrowserDemo />{/snippet}
</Story>

<Story name="Nothing chosen yet">
	{#snippet template()}<ColumnBrowserDemo initialGroup="general" initialItem="" />{/snippet}
</Story>
