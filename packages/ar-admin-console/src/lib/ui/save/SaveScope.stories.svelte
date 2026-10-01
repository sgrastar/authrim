<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import FieldsDemo from '../stories/FieldsDemo.svelte';
	import SettingsFormDemo from '../stories/SettingsFormDemo.svelte';
	import { sample } from '../stories/sample';
	import LeaveConfirm from './LeaveConfirm.svelte';
	import SaveScope from './SaveScope.svelte';

	// The props table's main tab (see named()).
	named(SaveScope, 'SaveScope');

	const { Story } = defineMeta({
		title: 'Patterns/Save scope',
		component: SaveScope,
		subcomponents: subcomponents({ LeaveConfirm }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Every settings page confirmed with Save wraps its form in `<SaveScope draft={…} onsave={…}>`, with a `Draft` holding the saved values and the ones on screen.\n\n- **Changed controls are marked.** Give a control `field` (a dotted path into `draft.value`); once its value differs from the saved one it takes the change colour (a warm tone of its own, softer than the warning colour): a field’s box, the whole option of a checkbox or radio, a cell of a choice grid, a ring on the exact control — and screen readers hear “(Changed)” after its label. In tables, `rowChanged` washes the row and the changed checkbox carries a ring, so both the row and the cell are clear. The save bar takes the same colour. Change it back and the mark goes. `CheckboxGroup` and `ChoiceGrid` mark each choice. For comparisons a path cannot express, pass `changed` yourself.\n- **The save bar rises from the bottom** as soon as anything is unsaved and sinks back after Save or Discard.\n- **While saving, everything inside is busy.** If `onsave` throws, the values stay unsaved and a toast says so.\n- **Leaving asks first.** Moving elsewhere in the console with unsaved changes stops and asks in the console’s dialog (stay is the safe default; leaving discards). Closing the tab, reloading or going to another site gets the browser’s own dialog — the only one a browser allows there. A jump within the page (#section) is not asked.\n- **Forms with their own Save button** (a dialog, a short inline form) set `bar={false}` and use the controls handed to their content — `{#snippet children(form)}` gives `form.save()`, `form.discard()`, `form.dirty`, `form.saving`. Changed fields are still marked and leaving still asks (see Patterns / Busy).\n\nToggles apply at once and are not part of a SaveScope.'
				}
			}
		}
	});
</script>

<Story
	name="Settings page"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Hidden from assistive tech while there is nothing to save, so find it by its label.
		const bar = canvasElement.querySelector<HTMLElement>(
			`[role="region"][aria-label="${t('common.unsaved')}"]`
		)!;
		await expect(bar).toHaveAttribute('aria-hidden', 'true');
		const name = canvas.getByRole('textbox', { name: sample('tenantName') });
		await userEvent.type(name, ' Japan');
		// The field says it changed, and the bar comes up.
		await expect(
			canvas.getByRole('textbox', { name: `${sample('tenantName')} (${t('common.changed')})` })
		).toBeInTheDocument();
		await expect(bar).not.toHaveAttribute('aria-hidden');
		// Discard: back to the saved value, bar goes down, mark goes.
		await userEvent.click(within(bar).getByRole('button', { name: t('common.discard') }));
		await waitFor(() => expect(name).toHaveValue('Acme Corporation'));
		await expect(bar).toHaveAttribute('aria-hidden', 'true');
		await expect(canvas.getByRole('textbox', { name: sample('tenantName') })).toBeInTheDocument();
	}}
>
	{#snippet template()}<div style="max-width:760px"><SettingsFormDemo /></div>{/snippet}
</Story>

<Story name="Saving fails">
	{#snippet template()}<div style="max-width:760px"><SettingsFormDemo failSave /></div>{/snippet}
</Story>

<Story
	name="Leaving with unsaved changes"
	play={async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
		await waitFor(() => expect(dialog).toBeVisible());
		await expect(
			within(dialog).getByRole('button', { name: t('unsaved.stay') })
		).toBeInTheDocument();
	}}
>
	{#snippet template()}<LeaveConfirm open onleave={() => {}} onstay={() => {}} />{/snippet}
</Story>

<Story
	name="A value that cannot be saved"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const sessions = canvas.getAllByRole('textbox')[2];
		await userEvent.clear(sessions);
		await userEvent.type(sessions, 'many');
		await userEvent.tab();
		// The bar says what is wrong, and Save leads to the field instead of saving.
		await waitFor(() => expect(canvas.getByText(t('common.fixErrors'))).toBeInTheDocument());
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(sessions).toHaveFocus());
		await expect(canvas.getByText(t('number.invalid'))).toBeInTheDocument();
	}}
>
	{#snippet template()}<FieldsDemo />{/snippet}
</Story>
