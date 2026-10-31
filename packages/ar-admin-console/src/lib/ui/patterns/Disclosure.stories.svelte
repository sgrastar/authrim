<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import DisclosureDemo from '../stories/DisclosureDemo.svelte';
	import Disclosure from './Disclosure.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Disclosure',
		component: Disclosure,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A section that opens on demand — “Advanced settings”, options that rarely change — built on `<details>`. A closed section never hides unsaved work: when a field inside carries the change mark, the heading shows “Changed” too. Open it from the start when it holds something that needs attention (an error). Do not fold away settings people look for often; move them out instead.\n\n**Boxed** (`boxed`) frames the section so a closed one is not overlooked among the fields around it — a settings form’s Advanced part. Marks about what is inside (`meta`, e.g. how many settings are overridden) sit right after the title.'
				}
			}
		}
	});
</script>

<Story
	name="In a form"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const summary = canvasElement.querySelector('summary') as HTMLElement;
		await userEvent.click(summary);
		const skew = await canvas.findByRole('textbox', { name: /skew|ずれ|Zeitabweichung|فرق/ });
		await userEvent.clear(skew);
		await userEvent.type(skew, '120');
		await userEvent.click(summary);
		// Closed again, the heading still says something inside is unsaved.
		await waitFor(() => expect(summary).toHaveTextContent(t('common.changed')));
		// The accessibility check runs after this: let the closing slide (a fade) finish first, so
		// it never measures a half-faded field.
		await waitFor(() => expect(summary.closest('details')).not.toHaveAttribute('open'));
	}}
>
	{#snippet template()}<DisclosureDemo />{/snippet}
</Story>

<Story name="Boxed, with a count">
	{#snippet template()}<DisclosureDemo boxed overridden={2} />{/snippet}
</Story>
