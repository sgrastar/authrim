<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';

	/**
	 * "Required" as a property of an item in a list or a row: an attribute a destination needs,
	 * a claim that must be sent. Not for form fields: a field the admin must fill marks its
	 * label with a red "*" (Design rules › Required).
	 *
	 * Outlined, so it reads apart from a type badge (filled, `string`) and a status badge
	 * (tinted, Enabled), and the same height as both, so they sit on one line. No colour: being
	 * required is not a status or a problem; a required item left empty is shown as a problem.
	 */
</script>

<span class="required-badge">{t('common.required')}</span>

<style>
	.required-badge {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		padding: 0 6px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-badge);
		background: transparent;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
	}
</style>
