<script lang="ts">
	/**
	 * How many things wait for the admin, next to a navigation entry ("3" alerts to review).
	 * The one badge in the danger colour: it asks for action. Say what is counted in the
	 * entry's accessible name; the number alone means little to a screen reader.
	 */
	interface Props {
		value: number | string;
	}

	let { value }: Props = $props();
</script>

<span class="count-badge">{value}</span>

<style>
	.count-badge {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		min-width: 1.6em;
		padding: 1px 6px;
		border-radius: var(--radius-round);
		background: var(--danger);
		color: var(--text-inverse);
		font-size: var(--fs-overline);
		font-weight: var(--fw-bold);
		font-variant-numeric: tabular-nums;
	}
</style>
