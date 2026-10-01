<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import DateTime from './DateTime.svelte';
	import TimeSettings from './TimeSettings.svelte';

	// The props table's main tab (see named()).
	named(DateTime, 'DateTime');

	const { Story } = defineMeta({
		title: 'Primitives/Date and time',
		component: DateTime,
		subcomponents: subcomponents({ TimeSettings }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Timestamps follow each admin’s choice (header → Display settings → Date and time): **UTC** or **local**, always with the zone named, plus a toggle to show the other one alongside (“Also show local time” when UTC is chosen, “Also show UTC” when local is chosen). The choice is stored per admin user. Calendar dates (e.g. a release date) are not instants and are never shifted. The tooltip always holds both zones with seconds; `zone`/`showSecondary` override the preference where a field must read one way (audit records in UTC).'
				}
			}
		}
	});

	const INSTANT = '2026-09-26T05:05:30Z';
	const LATE = '2026-09-26T20:40:00Z';
</script>

<Story name="Follows the preference">
	{#snippet template()}
		<div
			style="display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:24px;align-items:start"
		>
			<div
				style="padding:12px;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--bg-card)"
			>
				<TimeSettings />
			</div>
			<dl style="display:grid;grid-template-columns:auto 1fr;gap:10px 18px;margin:0;font-size:13px">
				<dt style="color:var(--text-muted)">{sample('createdAt')}</dt>
				<dd style="margin:0"><DateTime value={INSTANT} /></dd>
				<dt style="color:var(--text-muted)">{sample('lastSignInAt')}</dt>
				<dd style="margin:0"><DateTime value={LATE} seconds /></dd>
				<dt style="color:var(--text-muted)">{sample('certExpiry')}</dt>
				<dd style="margin:0"><DateTime value={LATE} style="date" /></dd>
				<dt style="color:var(--text-muted)">{sample('releaseDate')}</dt>
				<dd style="margin:0"><DateTime value="2024-03-01" style="date" /></dd>
				<dt style="color:var(--text-muted)">{sample('auditAt')}</dt>
				<dd style="margin:0"><DateTime value={INSTANT} zone="utc" seconds /></dd>
			</dl>
		</div>
	{/snippet}
</Story>

<Story name="All combinations">
	{#snippet template()}
		<table style="border-collapse:collapse;font-size:13px">
			<thead>
				<tr>
					<td></td>
					<th style="padding:6px 14px;text-align:start;color:var(--text-muted);font-weight:600"
						>{sample('zoneLocal')}</th
					>
					<th style="padding:6px 14px;text-align:start;color:var(--text-muted);font-weight:600"
						>{sample('zoneUtc')}</th
					>
				</tr>
			</thead>
			<tbody>
				<tr>
					<th style="padding:6px 14px;text-align:start;color:var(--text-muted);font-weight:600"
						>—</th
					>
					<td style="padding:6px 14px"
						><DateTime value={LATE} zone="local" showSecondary={false} /></td
					>
					<td style="padding:6px 14px"
						><DateTime value={LATE} zone="utc" showSecondary={false} /></td
					>
				</tr>
				<tr>
					<th style="padding:6px 14px;text-align:start;color:var(--text-muted);font-weight:600"
						>{sample('withOther')}</th
					>
					<td style="padding:6px 14px"
						><DateTime value={LATE} zone="local" showSecondary stacked /></td
					>
					<td style="padding:6px 14px"
						><DateTime value={LATE} zone="utc" showSecondary stacked /></td
					>
				</tr>
			</tbody>
		</table>
	{/snippet}
</Story>

<Story
	name="Changing the preference"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: 'UTC' }));
		await expect(canvas.getByText(/UTC$/, { selector: 'time' })).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('switch'));
		await expect(canvas.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
		// Reset for other stories.
		await userEvent.click(canvas.getByRole('switch'));
		await userEvent.click(canvas.getByRole('radio', { name: /./, checked: false }));
	}}
>
	{#snippet template()}<div style="max-width:300px">
			<TimeSettings example={INSTANT} />
		</div>{/snippet}
</Story>
