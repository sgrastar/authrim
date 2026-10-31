<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import CheckboxRow from './CheckboxRow.svelte';
	import CheckRow from './CheckRow.svelte';
	import Card from './Card.svelte';
	import FieldRow from './FieldRow.svelte';
	import RowStack from './RowStack.svelte';
	import SelectRow from './SelectRow.svelte';
	import TextAreaRow from './TextAreaRow.svelte';
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
						'**A setting whose value is short is a row: its name on the start side, the control on the end side.** The same two columns as the settings pages (`FieldRow`), so a form reads the same wherever it is.\n\n- `SelectRow` — a dropdown.\n- `TextRow` — a short text field: a name, an ID, a code.\n- `TextAreaRow` — a few lines of text (a description, a note): as wide as the other controls and three lines tall.\n- `CheckboxRow` — a few checkboxes, one under another.\n- `CheckRow` — one checkbox, for a yes / no confirmed with Save or a dialog’s button.\n- `ToggleRow` — an on/off switch that takes effect at once, with a line saying what *on* means.\n\nA value that is long keeps the control full width with its label above (a pasted document, a block of JSON or metadata, a table); a few lines of text is a row.\n\n**What a setting means goes behind a “?” beside its name (`info`), not in a line under the control.** What a person needs in order to fill it in correctly (a format, a limit) or to decide (what cannot be undone) stays visible under the field as its hint. A switch keeps its line saying what *on* means. A required setting has a red “*” after its name. The name is shown by the row and read with the control, which keeps it as its own label (hidden). On a narrow screen the name moves above the control.\n\nRows sit one under another in a form; the form’s own spacing separates them, with no dividing lines (a table of settings, which has lines, is `FieldRow` as it is).\n\n**Rows in a box:** put them in a `RowStack`, which keeps them a field gap (`--space-field`, 16px) apart. For a box of independent settings saved with the page, use `<RowStack ruled>`: a line between the rows, each with its own vertical space, as in the settings pages. A page never spaces rows itself, and never with a token that does not exist: an undefined one collapses to nothing and the rows touch.'
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

<Story
	name="Check row"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('checkbox', { name: /^Treat as personal data/ });
		await userEvent.click(box);
		await expect(box).toBeChecked();
		await expect(canvas.getByText('Kept apart. Fixed after creation.')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<div style="max-width: 720px">
			<CheckRow
				label="Personal data"
				text="Treat as personal data"
				description="Kept apart. Fixed after creation."
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

<!-- Rows in a box: a RowStack keeps them a field gap apart, so they never touch. -->
<Story
	name="Rows in a box"
	play={async ({ canvasElement }) => {
		const rows = [...canvasElement.querySelectorAll<HTMLElement>('.field-row')];
		await expect(rows.length).toBe(4);
		for (let i = 1; i < rows.length; i++) {
			const gap = rows[i].getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom;
			await expect(Math.round(gap)).toBe(16);
		}
	}}
>
	{#snippet template()}
		<div style="max-width: 720px">
			<Card title="Identity">
				<RowStack>
					<TextRow label="Key" />
					<TextRow label="Label" required />
					<SelectRow label="Type" options={choices()} />
					<CheckRow
						label="Required"
						text="Make it required"
						description="A line saying what it does."
					/>
				</RowStack>
			</Card>
		</div>
	{/snippet}
</Story>

<!-- A box of independent settings: lines between the rows, as in the settings pages. -->
<Story
	name="Rows in a box, ruled"
	play={async ({ canvasElement }) => {
		const rows = [...canvasElement.querySelectorAll<HTMLElement>('.field-row')];
		await expect(rows.length).toBe(4);
		await expect(getComputedStyle(rows[0]).borderTopWidth).toBe('0px');
		for (const row of rows.slice(1)) {
			await expect(getComputedStyle(row).borderTopWidth).toBe('1px');
			await expect(getComputedStyle(row).paddingTop).toBe('16px');
		}
	}}
>
	{#snippet template()}
		<div style="max-width: 720px">
			<Card title="Identity">
				<RowStack ruled>
					<TextRow label="Key" />
					<TextRow label="Label" required />
					<SelectRow label="Type" options={choices()} />
					<CheckRow
						label="Required"
						text="Make it required"
						description="A line saying what it does."
					/>
				</RowStack>
			</Card>
		</div>
	{/snippet}
</Story>

<!-- A few lines of text is a row: as wide as the other controls, three lines tall. -->
<Story
	name="Text area row"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const area = canvas.getByRole('textbox', { name: 'Description' });
		const text = canvas.getByRole('textbox', { name: 'Code' });
		await expect(area).toHaveAttribute('rows', '3');
		// Starts and ends where the other controls do.
		await expect(Math.round(area.getBoundingClientRect().left)).toBe(
			Math.round(text.getBoundingClientRect().left)
		);
		await expect(Math.round(area.getBoundingClientRect().right)).toBe(
			Math.round(text.getBoundingClientRect().right)
		);
		// What it means is behind the "?" beside its name.
		await expect(canvas.getByRole('button', { name: /Description/ })).toBeVisible();
	}}
>
	{#snippet template()}
		<div style="max-width: 720px">
			<RowStack>
				<TextRow label="Code" />
				<TextAreaRow label="Description" info="Shown to admins in the list; people never see it." />
			</RowStack>
		</div>
	{/snippet}
</Story>
