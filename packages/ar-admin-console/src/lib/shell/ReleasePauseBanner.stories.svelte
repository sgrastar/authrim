<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import ReleasePauseBanner from './ReleasePauseBanner.svelte';

	const { Story } = defineMeta({
		title: 'Shell/Release pause banner',
		component: ReleasePauseBanner,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Shown on every page while the environment is being updated and the Admin API takes no changes: a flat full-width band in the app shell’s `banner` slot, under the environment notice when both show, with no coloured edge (info tone for its fill, outline and text, so it does not read as the environment notice or as an error). It appears when a change is refused for this reason and goes away when a change is taken again, or by itself after a minute; the save that was refused also says so in its own toast. The band sits in a status region that is always there, so screen readers announce it. Use the language and theme toolbars to see it in each language (Arabic is right to left) and in each theme.'
				}
			}
		}
	});
</script>

<Story
	name="Changes paused"
	args={{ active: true }}
	play={async ({ canvasElement }) => {
		const status = within(canvasElement).getByRole('status');
		await expect(status).toBeVisible();
		await expect(status.textContent?.trim()).not.toBe('');
	}}
/>

<Story
	name="Nothing to show"
	args={{ active: false }}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).getByRole('status').textContent?.trim()).toBe('');
	}}
/>
