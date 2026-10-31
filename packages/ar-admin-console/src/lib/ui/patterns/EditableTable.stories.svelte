<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import SourceProfileDemo from '../stories/SourceProfileDemo.svelte';
	import EditableTable from './EditableTable.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Editable table',
		component: EditableTable,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'**EditableTable** — cells edited in place, for data that is naturally rows × columns: the attributes of an inbound or outbound source (path, label, type, flags). Text, choice and checkbox cells, each named for screen readers (“Type, mail”). ↑ / ↓ move between rows, Enter moves down and adds a row at the end. A range copied from a spreadsheet pastes into several cells and rows at once. Required and unique columns and custom checks show in the cell; changed cells and new rows take the change colour.\n\nIts attributes feed the **Attribute mapping** below it (see Patterns / Attribute mapping).\n\nThe story is an inbound SAML source.'
				}
			}
		}
	});
</script>

<Story
	name="Inbound source"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const table = canvas.getByRole('region', { name: /SAML/ });
		const cells = within(table).getAllByRole('textbox');
		const before = within(table).getAllByRole('row').length;
		// A block copied from a spreadsheet into a new row fills its cells and adds rows.
		await userEvent.click(canvas.getByRole('button', { name: t('grid.add') }));
		await waitFor(() =>
			expect(within(table).getAllByRole('textbox').length).toBe(cells.length + 2)
		);
		await userEvent.paste('department\tDepartment\tstring\nemployeeId\tEmployee ID\tstring');
		await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(before + 2));
	}}
>
	{#snippet template()}<SourceProfileDemo />{/snippet}
</Story>
