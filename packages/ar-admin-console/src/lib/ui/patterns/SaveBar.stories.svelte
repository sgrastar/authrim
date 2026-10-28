<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import SaveBar from './SaveBar.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Save bar',
		component: SaveBar,
		tags: ['autodocs'],
		args: { dirty: true, saving: false, onsave: fn(), ondiscard: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Rises from the bottom of the viewport as soon as there are unsaved changes and sinks back once they are saved or discarded; it sticks to the bottom while the page scrolls, so long forms can always be saved or discarded. Pages do not place it themselves — SaveScope does (see Patterns / Save scope).'
				}
			}
		}
	});
</script>

<Story
	name="Unsaved changes"
	play={async ({ canvasElement }) => {
		// Save is the action to take, and its frame pulses slowly.
		const save = within(canvasElement).getByRole('button', { name: t('common.save') });
		await expect(getComputedStyle(save).animationName).toContain('btn-attention');
	}}
/>

<Story
	name="Saving"
	args={{ saving: true }}
	play={async ({ canvasElement }) => {
		// Running: nothing to press, so nothing to draw the eye to.
		const save = within(canvasElement).getByRole('button', { name: t('common.saving') });
		await expect(getComputedStyle(save).animationName).toBe('none');
	}}
/>

<Story
	name="A field cannot be saved"
	args={{ invalid: true }}
	play={async ({ canvasElement }) => {
		// The bar is asking for a fix first: Save does not pulse.
		const save = within(canvasElement).getByRole('button', { name: t('common.save') });
		await expect(getComputedStyle(save).animationName).toBe('none');
	}}
/>
