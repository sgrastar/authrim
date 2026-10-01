<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { localized } from '../stories/sample';
	import DurationField from './DurationField.svelte';
	import NumberField from './NumberField.svelte';

	named(NumberField, 'NumberField');

	const { Story } = defineMeta({
		title: 'Primitives/Number field',
		component: NumberField,
		subcomponents: subcomponents({ DurationField }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'**NumberField** — a number with its unit in the box: limits, counts, retention days. Typing is read leniently (full-width digits, “1,000”); the value only changes to a number that fits `min` / `max` (whole numbers unless `decimal`). A problem is explained once the admin leaves the box, and `bind:invalid` lets the page hold Save. ↑ / ↓ step (Shift: by ten). Empty is `null`, not zero.\n\n**DurationField** — a length of time, stored in seconds and shown in the unit that reads best (86400 → 1 day). Changing the unit keeps the number (“30” + minutes); the total in seconds shows underneath. `min` / `max` are seconds, explained in readable units.'
				}
			}
		}
	});

	const sessions = () =>
		localized([
			'同時にログインできる数',
			'Concurrent sign-ins',
			'Gleichzeitige Anmeldungen',
			'عمليات الدخول المتزامنة'
		]);
	const unit = () => localized(['件', 'sign-ins', 'Anmeldungen', 'عمليات']);
	const lifetime = () =>
		localized(['セッションの有効期間', 'Session lifetime', 'Sitzungsdauer', 'مدة الجلسة']);
</script>

<Story
	name="With a unit"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByRole('textbox');
		await userEvent.clear(input);
		await userEvent.type(input, '0');
		await userEvent.tab();
		await waitFor(() =>
			expect(canvas.getByText(t('number.range', { min: '1', max: '100' }))).toBeInTheDocument()
		);
		await expect(input).toHaveAttribute('aria-invalid', 'true');
	}}
>
	{#snippet template()}
		<NumberField label={sessions()} unit={unit()} min={1} max={100} value={5} />
	{/snippet}
</Story>

<Story
	name="Duration"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// 86400 seconds reads as one day.
		await expect(canvas.getByRole('textbox')).toHaveValue('1');
		await userEvent.selectOptions(canvas.getByRole('combobox'), 'hours');
		await waitFor(() =>
			expect(canvas.getByText(t('duration.total', { n: 3600 }))).toBeInTheDocument()
		);
	}}
>
	{#snippet template()}
		<DurationField label={lifetime()} value={86_400} min={300} max={2_592_000} />
	{/snippet}
</Story>

<Story name="Sizes">
	{#snippet template()}
		<div style="display:grid;gap:16px">
			<NumberField label={t('set.k.session.backchannel_retry_max_attempts')} value={3} />
			<NumberField label={t('set.k.session.backchannel_retry_max_attempts')} size="sm" value={3} />
		</div>
	{/snippet}
</Story>
