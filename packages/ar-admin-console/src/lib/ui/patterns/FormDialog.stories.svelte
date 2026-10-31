<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import TextField from '../primitives/TextField.svelte';
	import FormDialog from './FormDialog.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Form dialog',
		component: FormDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Modal with a few fields: naming something, entering one value. Built on `<dialog>` with a real `<form>`, so Enter submits and Esc cancels. A failure is shown inside the dialog, which stays open so the admin can retry without typing again. Anything longer than a couple of fields belongs on a page, not in a dialog.'
				}
			}
		}
	});

	const onsubmit = fn();
</script>

<Story
	name="Name something"
	play={async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
		await waitFor(() => expect(dialog).toBeVisible());
		await userEvent.type(within(dialog).getByRole('textbox'), 'YubiKey{Enter}');
		await expect(onsubmit).toHaveBeenCalled();
	}}
>
	{#snippet template()}
		<FormDialog
			open
			title={t('me.passkey.add')}
			description={t('me.passkey.addBody')}
			submitLabel={t('me.passkey.create')}
			{onsubmit}
			oncancel={() => {}}
		>
			<TextField label={t('me.passkey.name')} hint={t('me.passkey.nameHint')} />
		</FormDialog>
	{/snippet}
</Story>

<Story name="With an error">
	{#snippet template()}
		<FormDialog
			open
			title={t('me.passkey.add')}
			description={t('me.passkey.addBody')}
			submitLabel={t('me.passkey.create')}
			error={t('me.passkey.duplicate')}
			onsubmit={() => {}}
			oncancel={() => {}}
		>
			<TextField label={t('me.passkey.name')} value="Work MacBook" />
		</FormDialog>
	{/snippet}
</Story>
