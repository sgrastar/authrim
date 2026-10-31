<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import ConfirmDialog from './ConfirmDialog.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Confirm dialog',
		component: ConfirmDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Modal confirmation built on `<dialog>`: focus stays inside and Esc cancels. Use before discarding work or doing something that cannot be undone.'
				}
			}
		}
	});

	const onconfirm = fn();
</script>

<Story
	name="Danger"
	play={async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
		// The dialog fades in; wait until the entrance animation has made it visible.
		await waitFor(() => expect(dialog).toBeVisible());
		await userEvent.click(within(dialog).getByRole('button', { name: sample('close') }));
		await expect(onconfirm).toHaveBeenCalled();
	}}
>
	{#snippet template()}
		<ConfirmDialog
			open
			tone="danger"
			title={sample('closeNodeTitle')}
			body={sample('closeNodeBody')}
			confirmLabel={sample('close')}
			{onconfirm}
			oncancel={() => {}}
		/>
	{/snippet}
</Story>
