<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';

	/**
	 * "Required" as a property of an item in a list, a row or a step of a flow: an attribute a
	 * destination needs, a claim that must be sent, a setting still to be made. Not for form
	 * fields: a field the admin must fill marks its label with a red "*" (Design rules › Required).
	 *
	 * Tinted in the warning colour, so what still has to be done stands out; no dot in front, which
	 * is for a status. The same height as the other badges, so they sit on one line.
	 */

	interface Props {
		/** `sm`: for a status line inside a compact node (the steps of a flow). */
		size?: 'md' | 'sm';
	}

	let { size = 'md' }: Props = $props();
</script>

<span class="required-badge" class:required-badge--sm={size === 'sm'}>{t('common.required')}</span>

<style>
	.required-badge {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		padding: 2px 8px;
		border: 1px solid color-mix(in srgb, var(--warning) 22%, transparent);
		border-radius: var(--radius-badge);
		background: var(--warning-bg);
		color: var(--warning);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
	}

	.required-badge--sm {
		padding: 1px 6px;
		font-size: var(--fs-overline);
	}
</style>
