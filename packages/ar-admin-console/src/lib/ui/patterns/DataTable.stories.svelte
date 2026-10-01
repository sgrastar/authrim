<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import NotApplicable from './NotApplicable.svelte';
	import Badge from '../primitives/Badge.svelte';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';
	import DataTable from './DataTable.svelte';
	import EmptyState from './EmptyState.svelte';
	import SelectableTableDemo from '../stories/SelectableTableDemo.svelte';
	import SortableTableDemo from '../stories/SortableTableDemo.svelte';
	import MethodMatrixDemo from '../stories/MethodMatrixDemo.svelte';
	import DateTime from '../time/DateTime.svelte';
	import CellText from './CellText.svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';

	// The props table's main tab (see named()).
	named(DataTable, 'DataTable');

	const { Story } = defineMeta({
		title: 'Patterns/Data table',
		component: DataTable,
		subcomponents: subcomponents({ CellText, NotApplicable }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Tabular list with fixed column widths (so grouped tables line up) and a hidden caption for screen readers. On phones it scrolls sideways instead of collapsing columns. Place it in a `flush` Card.\n\n**Sorting:** mark columns `sortable` and bind `sort`; the header shows the direction and sets `aria-sort`. Sort on the client with `sortRows()` or pass the state to the API.\n\n**Selection:** `selectable` adds a checkbox column and binds `selected` (row keys). The header checkbox selects or clears the visible rows (mixed state when some are selected); while rows are selected a bar offers select all, clear selection and the page’s bulk actions.\n\n**Rows with more than one line:** `CellText` puts a name, a short description and optionally a link in one cell — for rows whose name alone does not say what they are.\n\n**Checkboxes in cells:** a matrix of choices confirmed with Save (checkboxes, not switches — switches mean it applies at once). Centre those columns (`align` = `center`), give each box a full accessible name (“Passkey — Sign-up”), and mark cells that do not apply with `NotApplicable` rather than a disabled box.'
				}
			}
		}
	});

	type Flow = { id: string; name: string; protocol: string; on: boolean; todo: number };
	const flows: Flow[] = [
		{ id: 'login', name: 'flowLogin', protocol: 'OIDC', on: true, todo: 0 },
		{ id: 'scim-out', name: 'flowSlack', protocol: 'SCIM', on: false, todo: 1 },
		{ id: 'vc', name: 'flowVc', protocol: 'VC', on: false, todo: 2 }
	];
	/** Called from the template so the labels follow the toolbar language. */
	const columns = () => [
		{ key: 'name', label: sample('colFlow'), width: '46%' },
		{ key: 'protocol', label: sample('colProtocol'), width: '18%' },
		{ key: 'status', label: sample('colStatus'), width: '16%' },
		{ key: 'setup', label: sample('colSetup'), width: '20%' }
	];
</script>

<Story name="Default">
	{#snippet template()}
		<Card flush>
			<DataTable
				caption={sample('flowsTitle')}
				columns={columns()}
				rows={flows}
				rowKey={(row) => row.id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'name'}<strong>{sample(row.name as 'flowLogin')}</strong>
					{:else if column.key === 'protocol'}<code>{row.protocol}</code>
					{:else if column.key === 'status'}
						<Badge tone={row.on ? 'success' : 'neutral'} dot>
							{row.on ? sample('enabled') : sample('disabled')}
						</Badge>
					{:else}{row.todo === 0 ? sample('configured') : sample('missing')}{/if}
				{/snippet}
			</DataTable>
		</Card>
	{/snippet}
</Story>

<Story name="Empty">
	{#snippet template()}
		<Card flush>
			<DataTable
				caption={sample('invitations')}
				columns={columns()}
				rows={[]}
				rowKey={(row: Flow) => row.id}
			>
				{#snippet cell()}{/snippet}
				{#snippet empty()}
					<EmptyState
						icon="mail"
						title={sample('noInvitations')}
						description={sample('noInvitationsDesc')}
					>
						{#snippet action()}<Button variant="primary" icon="plus">{sample('invite')}</Button
							>{/snippet}
					</EmptyState>
				{/snippet}
			</DataTable>
		</Card>
	{/snippet}
</Story>

<Story name="Sortable headers">
	{#snippet template()}<SortableTableDemo />{/snippet}
</Story>

<Story
	name="Selectable rows"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const boxes = canvas.getAllByRole('checkbox');
		await userEvent.click(boxes[1]);
		await expect(boxes[0]).toBePartiallyChecked();
		await userEvent.click(boxes[0]);
		await waitFor(() =>
			expect(
				canvas.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)
			).toBe(true)
		);
	}}
>
	{#snippet template()}<SelectableTableDemo />{/snippet}
</Story>

<Story name="Selectable rows (some selected)">
	{#snippet template()}<SelectableTableDemo initial={['u1', 'u3']} />{/snippet}
</Story>

<Story name="Rows with more than one line">
	{#snippet template()}
		<Card title={sample('authMethodsTitle')} flush>
			<DataTable
				caption={sample('authMethodsTitle')}
				columns={[
					{ key: 'method', label: sample('colMethod'), width: '60%' },
					{ key: 'updated', label: sample('updated') }
				]}
				rows={[
					{ id: 'passkey', name: 'passkey', desc: 'passkeyDesc', at: '2026-09-20T02:00:00Z' },
					{ id: 'email', name: 'emailCode', desc: 'emailCodeDesc', at: '2026-08-02T09:30:00Z' },
					{ id: 'totp', name: 'methodTotp', desc: 'methodTotpDesc', at: '2026-06-11T04:15:00Z' }
				] as const}
				rowKey={(row) => row.id}
			>
				{#snippet cell(row, column)}
					{#if column.key === 'method'}
						<CellText title={sample(row.name)} description={sample(row.desc)} />
					{:else}
						<DateTime value={row.at} />
					{/if}
				{/snippet}
			</DataTable>
		</Card>
	{/snippet}
</Story>

<Story
	name="Checkboxes in cells"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('checkbox', {
			name: `${sample('emailCode')} — ${sample('useLogin')}`
		});
		await userEvent.click(box);
		await expect(box).toBeChecked();
		await expect(canvas.getAllByText(sample('methodDirectory')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}<MethodMatrixDemo />{/snippet}
</Story>
