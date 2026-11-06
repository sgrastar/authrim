<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StepUpDialog from './StepUpDialog.svelte';

	const { Story } = defineMeta({
		title: 'Shell/Step-up dialog',
		component: StepUpDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Asks the admin before a step-up: the operation’s level and the checks it takes ("This operation is L2. It takes one passkey verification and one second-factor verification (security key or Keyring). Continue?"). Mounted once by the console; every operation run through `withStepUp` asks here, from the tenant’s requirements (`/api/admin/me/step-up/requirements` and `stepUpFactorsNeeded()`) when the operation is named, else from the refusal. Declining runs neither the checks nor the operation.'
				}
			}
		}
	});

	const onanswer = fn();
</script>

<Story
	name="L1: a passkey"
	play={async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
		await waitFor(() => expect(dialog).toBeVisible());
		await expect(dialog).toHaveTextContent('L1');
		await userEvent.click(within(dialog).getByRole('button', { name: t('stepUp.confirm') }));
		await expect(onanswer).toHaveBeenCalledWith(true);
	}}
>
	{#snippet template()}
		<StepUpDialog request={{ level: 'L1', factors: ['passkey'] }} {onanswer} />
	{/snippet}
</Story>

<Story name="L2: a passkey and a security key">
	{#snippet template()}
		<StepUpDialog request={{ level: 'L2', factors: ['passkey', 'second_factor'] }} />
	{/snippet}
</Story>
