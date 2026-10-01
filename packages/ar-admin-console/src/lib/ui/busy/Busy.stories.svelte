<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import BusyDemo from '../stories/BusyDemo.svelte';
	import { sample } from '../stories/sample';
	import BusyScope from './BusyScope.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Busy',
		component: BusyScope,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'While an action runs (signing in, saving), nothing around it may start another action or change what is being sent. Wrap the area in `<BusyScope busy={…}>` — or pass `busy` to `AuthLayout`, `Form`, `FormDialog`, `ConfirmDialog` — and every control inside follows on its own:\n\n- **Buttons, icon buttons, choices, selects, toggles, sliders** — disabled.\n- **The button that started it** — `loading`: spinner, clicks ignored, but still focusable (`aria-disabled`), so keyboard and screen-reader users keep their place.\n- **Text fields, text areas, code fields** — read-only and dimmed, not disabled: focus and the typed text stay where they were.\n- **Links** — stop navigating and read as unavailable.\n\nScopes nest; a control is busy when any scope around it is. Pages only decide *when* it is busy — the component decides *how*.'
				}
			}
		}
	});
</script>

<Story name="Try it">
	{#snippet template()}<div style="max-width:480px"><BusyDemo /></div>{/snippet}
</Story>

<Story
	name="Busy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const saving = canvas.getByRole('button', { name: sample('saving') });
		// The running action keeps focus; the others are disabled.
		await expect(saving).toHaveAttribute('aria-disabled', 'true');
		await expect(saving).not.toBeDisabled();
		await expect(canvas.getByRole('button', { name: sample('cancel') })).toBeDisabled();
		await expect(canvas.getByRole('checkbox')).toBeDisabled();
		for (const field of canvas.getAllByRole('textbox')) {
			await expect(field).toHaveAttribute('readonly');
		}
		const link = canvas.getByRole('link');
		await expect(link).toHaveAttribute('aria-disabled', 'true');
		await expect(link).not.toHaveAttribute('href');
		await userEvent.click(saving);
		await expect(saving).toHaveAttribute('aria-busy', 'true');
	}}
>
	{#snippet template()}<div style="max-width:480px"><BusyDemo busy /></div>{/snippet}
</Story>
