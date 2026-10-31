<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import ToastAllTones, { showAllTones } from '../stories/ToastAllTones.svelte';
	import ToastDemo from '../stories/ToastDemo.svelte';
	import Toaster from './Toaster.svelte';
	import { toast } from './toast.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Toast',
		component: Toaster,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				// Inline (a separate frame would not receive the toolbar theme), tall enough for
				// all four tones: the stack is fixed to the preview block.
				story: { height: '440px' },
				description: {
					component:
						'Notifications, same behaviour as the legacy Admin UI toaster: `toast.success / error / warning / info(message)`. Durations 5s / 8s / 7s / 5s, identical messages within 1.2s are merged, at most four on screen, hovering pauses every timer (the bar shows the time left). Errors are announced immediately (`role="alert"`). `<Toaster />` is mounted once in the root layout and has no props; toasts are raised through the `toast` API.\n\n| Call | What it does |\n| --- | --- |\n| `toast.success / error / warning / info(message, options?)` | shows a toast; `message` may be an Error |\n| `toast.dismiss(id)` / `toast.dismissAll()` | closes one / all |\n\n| Option | Meaning |\n| --- | --- |\n| `title` | heading; defaults to the tone (Done, Error, …) |\n| `duration` | milliseconds before it closes; `0` keeps it until dismissed |\n| `dedupeKey` / `dedupeWindow` | merge repeats of the same message within the window (default 1.2s) |\n\nWhile a dialog is open, show its outcome inside the dialog instead (Design rules › Layers and shadows).'
				}
			}
		}
	});
</script>

<Story name="Try it">
	{#snippet template()}<div style="padding:24px"><ToastDemo /></div>{/snippet}
</Story>

<Story
	name="All tones"
	play={async ({ canvasElement }) => {
		// The demo puts every tone on screen when it mounts.
		const body = within(canvasElement.ownerDocument.body);
		await waitFor(() => expect(body.getAllByRole('status')).toHaveLength(3));
		await expect(body.getByRole('alert')).toBeInTheDocument();
		await userEvent.click(body.getAllByRole('button', { name: /./ }).at(-1)!);
		await waitFor(() => expect(toast.items).toHaveLength(3));
		showAllTones();
	}}
>
	{#snippet template()}<ToastAllTones />{/snippet}
</Story>
