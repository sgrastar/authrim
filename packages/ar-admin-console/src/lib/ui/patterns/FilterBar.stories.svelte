<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import SearchField from '../primitives/SearchField.svelte';
	import FilterDemo from '../stories/FilterDemo.svelte';
	import { localized } from '../stories/sample';
	import DateRangeField from './DateRangeField.svelte';
	import FilterBar from './FilterBar.svelte';

	named(FilterBar, 'FilterBar');

	const { Story } = defineMeta({
		title: 'Patterns/Filter bar',
		component: FilterBar,
		subcomponents: subcomponents({ SearchField, DateRangeField }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The row above a list that narrows it: **SearchField**, then filters (Select, SelectMenu, **DateRangeField** — all `size="sm"` so they line up), then the number of results and “Clear filters” while anything narrows the list. The count is announced as it changes. Sits directly above the list’s card.\n\n**SearchField** fires `onsearch` a moment after typing stops (at once on Enter or clear); Esc or × clears. Its placeholder names what can be searched — the one placeholder allowed to say something.\n\n**DateRangeField** offers recent spans or a custom start and end, typed in the zone the admin chose for timestamps (local or UTC) and kept as ISO instants; `resolveRange()` turns it into bounds for a query.'
				}
			}
		}
	});
</script>

<Story
	name="User list"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const search = canvas.getByRole('searchbox');
		await userEvent.type(search, 'aiko');
		await waitFor(() =>
			expect(canvas.getByText(t('filter.results', { n: 1 }))).toBeInTheDocument()
		);
		// Something narrows the list: the way back appears, and brings everything back.
		await userEvent.click(canvas.getByRole('button', { name: t('filter.clearAll') }));
		await waitFor(() => expect(search).toHaveValue(''));
		await expect(canvas.queryByRole('button', { name: t('filter.clearAll') })).toBeNull();
	}}
>
	{#snippet template()}<FilterDemo />{/snippet}
</Story>

<Story name="Date range, custom">
	{#snippet template()}
		<DateRangeField
			label={localized(['期間', 'Period', 'Zeitraum', 'الفترة'])}
			zone="utc"
			value={{ preset: 'custom', from: '2026-09-01T00:00:00Z', to: '2026-08-31T00:00:00Z' }}
		/>
	{/snippet}
</Story>
