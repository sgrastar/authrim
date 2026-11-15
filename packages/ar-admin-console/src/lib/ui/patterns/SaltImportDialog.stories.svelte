<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { fakeFingerprint } from '#lib/api/fake/identifier-materials-fake.js';
	import SaltImportDemo from '../stories/SaltImportDemo.svelte';
	import SaltImportDialog from './SaltImportDialog.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Salt import',
		component: SaltImportDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Imports a salt brought from another identity provider under a name, for the persistent identifier step (a form dialog with a secret field). The salt is entered as text (as the IdP held it) or as Base64, is never shown again and never comes back from the server: only its **fingerprint** does.\n\nThe result is one of three: **created**; **unchanged** (the same salt was kept already); **replaced**. A different salt under a name already used is refused by the server (409), so the dialog asks first, naming the fingerprint of the salt that is kept, and replaces it only on a yes (the fingerprint is sent back as proof of what is being replaced).'
				}
			}
		}
	});

	/** The open dialog, and the secret typed into it. */
	const dialogOf = (canvasElement: HTMLElement) =>
		within(canvasElement.ownerDocument.body).getByRole('dialog', { name: t('pid.salt.title') });

	async function enter(canvasElement: HTMLElement, name: string, secret: string) {
		const dialog = dialogOf(canvasElement);
		await waitFor(() => expect(dialog).toBeVisible());
		const field = within(dialog).getByRole('textbox', { name: new RegExp(t('pid.salt.name')) });
		await userEvent.clear(field);
		await userEvent.type(field, name);
		const input = dialog.querySelector<HTMLInputElement>('input[type=password]');
		await userEvent.type(input!, secret);
	}

	const submit = (canvasElement: HTMLElement) =>
		userEvent.click(
			within(dialogOf(canvasElement)).getByRole('button', { name: t('pid.salt.submit') })
		);
</script>

<Story
	name="Created"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'new-salt', 'my secret');
		await submit(canvasElement);
		await waitFor(() =>
			expect(within(canvasElement).getByTestId('outcome')).toHaveTextContent(
				t('pid.result.salt.created', {
					name: 'new-salt',
					fingerprint: fakeFingerprint('my secret')
				})
			)
		);
	}}
>
	{#snippet template()}<SaltImportDemo />{/snippet}
</Story>

<Story
	name="Unchanged (the same salt again)"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'legacy-idp', 'legacy salt');
		await submit(canvasElement);
		await waitFor(() =>
			expect(within(canvasElement).getByTestId('outcome')).toHaveTextContent(
				t('pid.result.salt.unchanged', { name: 'legacy-idp' })
			)
		);
	}}
>
	{#snippet template()}<SaltImportDemo />{/snippet}
</Story>

<Story
	name="A different salt asks before replacing (409)"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'legacy-idp', 'another salt');
		await submit(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const confirm = await body.findByRole('dialog', {
			name: t('pid.salt.replaceTitle', { name: 'legacy-idp' })
		});
		// It names the fingerprint of the salt that is kept, never a value.
		await expect(confirm).toHaveTextContent(fakeFingerprint('legacy salt'));
		await userEvent.click(
			within(confirm).getByRole('button', { name: t('pid.salt.replaceConfirm') })
		);
		await waitFor(() =>
			expect(within(canvasElement).getByTestId('outcome')).toHaveTextContent(
				t('pid.result.salt.replaced', {
					name: 'legacy-idp',
					fingerprint: fakeFingerprint('another salt')
				})
			)
		);
	}}
>
	{#snippet template()}<SaltImportDemo />{/snippet}
</Story>

<Story
	name="Cleared when closed"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'new-salt', 'my secret');
		const dialog = dialogOf(canvasElement);
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('secret.show', { name: t('pid.salt.value') }) })
		);
		await expect(
			dialog.querySelector('input[type=text][autocomplete=new-password]')
		).not.toBeNull();
		await userEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
		await waitFor(() => expect(dialog).not.toBeVisible());
		// Opened again: nothing typed, and the secret is hidden once more.
		await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reopen' }));
		await waitFor(() => expect(dialog).toBeVisible());
		const input = dialog.querySelector<HTMLInputElement>('input[autocomplete=new-password]');
		await expect(input).toHaveAttribute('type', 'password');
		await expect(input).toHaveValue('');
	}}
>
	{#snippet template()}<SaltImportDemo />{/snippet}
</Story>

<Story
	name="Salt list cannot be read after a 409"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'legacy-idp', 'another salt');
		await submit(canvasElement);
		// A failed lookup is said as such, not as "no more salts"; no replace is offered.
		const dialog = dialogOf(canvasElement);
		await expect(await within(dialog).findByText(t('pid.salt.error.lookup'))).toBeVisible();
		await expect(within(dialog).queryByText(t('pid.salt.error.limit'))).toBeNull();
	}}
>
	{#snippet template()}<SaltImportDemo mode="listFails" />{/snippet}
</Story>

<Story
	name="Name not in the list after a 409 (no room)"
	play={async ({ canvasElement }) => {
		await enter(canvasElement, 'brand-new', 'another salt');
		await submit(canvasElement);
		await expect(
			await within(dialogOf(canvasElement)).findByText(t('pid.salt.error.limit'))
		).toBeVisible();
	}}
>
	{#snippet template()}<SaltImportDemo mode="limit" />{/snippet}
</Story>
