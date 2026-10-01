<script lang="ts">
	import { i18n } from '$lib/i18n/i18n.svelte';
	import { formatTime, type TimeInput, type TimeStyle, type TimeZoneMode } from './format-time';
	import { timePreference } from './time-preference.svelte';

	/**
	 * A timestamp in the admin's chosen zone (UTC or local), always with the zone named. When the
	 * admin also asked for the other zone, it follows in a quieter tone. Calendar dates are shown
	 * as written. The full value in both zones is in the tooltip.
	 */
	interface Props {
		value: TimeInput;
		style?: TimeStyle;
		seconds?: boolean;
		/** Put the secondary zone on its own line (tables) instead of inline. */
		stacked?: boolean;
		/** Override the admin's preference (e.g. a field that must always read in UTC). */
		zone?: TimeZoneMode;
		showSecondary?: boolean;
	}

	let {
		value,
		style = 'datetime',
		seconds = false,
		stacked = false,
		zone: zoneOverride,
		showSecondary: secondaryOverride
	}: Props = $props();

	const zone = $derived(zoneOverride ?? timePreference.zone);
	const withSecondary = $derived(secondaryOverride ?? timePreference.showSecondary);

	const primary = $derived(formatTime(value, { locale: i18n.locale, zone, style, seconds }));
	const other = $derived(
		formatTime(value, {
			locale: i18n.locale,
			zone: zone === 'utc' ? 'local' : 'utc',
			style,
			seconds
		})
	);
	// Calendar dates have no zone, so there is nothing to add; the same goes when both zones
	// read the same (an admin working in UTC).
	const secondary = $derived(
		withSecondary && primary?.zone && other && other.text !== primary.text ? other : null
	);
	const full = $derived(
		[
			formatTime(value, { locale: i18n.locale, zone: 'utc', style: 'datetime', seconds: true }),
			formatTime(value, { locale: i18n.locale, zone: 'local', style: 'datetime', seconds: true })
		]
			.filter((item) => item?.zone)
			.map((item) => item!.text)
			.join(' / ')
	);
</script>

{#if primary}
	<!-- A date alone carries no zone, but next to another zone's date it must say which is which. -->
	{@const label = (item: { text: string; zone: string }) =>
		style === 'date' && secondary ? `${item.text} ${item.zone}` : item.text}
	<span class="datetime" class:datetime--stacked={stacked} title={full || undefined}>
		<time datetime={primary.iso}>{label(primary)}</time>
		{#if secondary}<span class="datetime__other">{label(secondary)}</span>{/if}
	</span>
{:else}
	<span class="datetime datetime--invalid">—</span>
{/if}

<style>
	.datetime {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 8px;
		font-variant-numeric: tabular-nums;
		/* Digits and zone labels keep their order in right-to-left pages. */
		unicode-bidi: isolate;
	}

	/* Each zone's text stays in one piece; only the break between the two zones may wrap. */
	.datetime > * {
		white-space: nowrap;
	}

	.datetime--stacked {
		display: inline-grid;
		gap: 1px;
	}

	.datetime__other {
		color: var(--text-muted);
		font-size: 0.9em;
	}

	.datetime--invalid {
		color: var(--text-muted);
	}
</style>
