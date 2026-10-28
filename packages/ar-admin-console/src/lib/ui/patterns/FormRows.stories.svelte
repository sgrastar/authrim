<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import CheckboxRow from './CheckboxRow.svelte';
	import FieldRow from './FieldRow.svelte';
	import SelectRow from './SelectRow.svelte';
	import TextRow from './TextRow.svelte';
	import ToggleRow from './ToggleRow.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Form rows',
		component: FieldRow,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'**A setting whose value is short is a row: its name on the start side, the control on the end side.** The same two columns as the settings pages (`FieldRow`), so a form reads the same wherever it is.\n\n- `SelectRow` — a dropdown.\n- `TextRow` — a short text field: a name, an ID, a code.\n- `CheckboxRow` — a few checkboxes, one under another.\n- `ToggleRow` — an on/off switch, with a line saying what *on* means.\n\nA value that is long keeps the control full width with its label above (an address list, a pasted document, a block of metadata, a table). A required setting has a red “*” after its name. The name is shown by the row and read with the control, which keeps it as its own label (hidden). On a narrow screen the name moves above the control.\n\nRows sit one under another in a form; the form’s own spacing separates them, with no dividing lines (a table of settings, which has lines, is `FieldRow` as it is).'
				}
			}
		}
	});

	const choices = () => [
		{ value: 'a', label: sample('colFlow') },
		{ value: 'b', label: sample('colProtocol') }
	];
</script>

<!-- Every kind of row: names on one side, controls lined up on the other. -->
<Story
	name="One of each"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const controls = [
			canvas.getByRole('combobox', { name: 'Method' }),
			canvas.getByRole('textbox', { name: 'Code' }),
			canvas.getByRole('checkbox', { name: 'Email' }),
			canvas.getByRole('switch', { name: 'Require it' })
		];
		const lefts = controls.map((control) => Math.round(control.getBoundingClientRect().left));
		// The controls start in one column (the checkbox and the switch are narrower than a field,
		// but begin at its start edge).
		await expect(new Set(lefts).size).toBe(1);
		// And the names are on the start side, level with the first line of their control.
		const name = canvas.getByText('Method', { selector: '.field-row__label' });
		await expect(name.getBoundingClientRect().right).toBeLessThan(lefts[0]);
		// A required row is marked after its name, and its control is required.
		await expect(canvas.getByRole('combobox', { name: 'Method' })).toBeRequired();
		await expect(name.querySelector('.field-row__req')).toHaveTextContent('*');
		// Rows are a field-gap (16px) apart, with no line between them.
		const rows = [...canvasElement.querySelectorAll<HTMLElement>('.field-row')];
		for (const row of rows) await expect(getComputedStyle(row).borderTopWidth).toBe('0px');
		for (let i = 1; i < rows.length; i++) {
			const gap = rows[i].getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom;
			await expect(Math.round(gap)).toBeGreaterThanOrEqual(16);
		}
		// The switch is read with what on means; a required group says that it is.
		await expect(controls[3]).toHaveAccessibleDescription('What happens when it is on.');
		await expect(canvas.getByRole('group', { name: 'Send to' })).toHaveAccessibleDescription(
			'Choose at least one.'
		);
		// The checkbox is chosen from its row.
		await userEvent.click(controls[2]);
		await expect(controls[2]).toBeChecked();
	}}
>
	{#snippet template()}
		<div style="max-width: 720px; display: flex; flex-direction: column; gap: 16px">
			<SelectRow
				label="Method"
				required
				placeholder="Choose"
				hint="What the choice means, under the dropdown."
				options={choices()}
			/>
			<TextRow label="Code" hint="A short value." />
			<CheckboxRow
				label="Send to"
				required
				hint="Choose at least one."
				options={[
					{ value: 'email', label: 'Email' },
					{ value: 'sms', label: 'SMS', description: 'A line of explanation under it.' }
				]}
			/>
			<ToggleRow label="Require it" description="What happens when it is on." />
		</div>
	{/snippet}
</Story>

<Story name="Select row">
	{#snippet template()}
		<div style="max-width: 720px">
			<SelectRow label="Method" info="What it does, behind a question mark." options={choices()} />
		</div>
	{/snippet}
</Story>

<Story name="Text row">
	{#snippet template()}
		<div style="max-width: 720px">
			<TextRow label="Service flow name" required placeholder="Standard sign-in" />
		</div>
	{/snippet}
</Story>

<Story name="Checkbox row">
	{#snippet template()}
		<div style="max-width: 720px">
			<CheckboxRow
				label="Details to collect"
				required
				options={[
					{ value: 'email', label: 'Email address' },
					{ value: 'name', label: 'Name' },
					{ value: 'phone', label: 'Phone number' }
				]}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Toggle row">
	{#snippet template()}
		<div style="max-width: 720px">
			<ToggleRow label="Require PKCE" description="Recommended for every app." checked />
		</div>
	{/snippet}
</Story>

<!-- A narrow screen puts the name above the control. -->
<Story
	name="Narrow screen"
	parameters={{ viewport: { defaultViewport: 'mobile1' } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const control = canvas.getByRole('textbox', { name: 'Code' });
		const name = canvas.getByText('Code', { selector: '.field-row__label' });
		await expect(name.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			control.getBoundingClientRect().top + 1
		);
	}}
>
	{#snippet template()}
		<div style="width: 360px">
			<TextRow label="Code" />
		</div>
	{/snippet}
</Story>
