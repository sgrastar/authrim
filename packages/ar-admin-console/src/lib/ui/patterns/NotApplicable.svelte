<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';

	/**
	 * A table cell where the column does not apply to the row (a method that cannot be used for
	 * sign-up). A quiet dash, read out as "Not applicable" — not an empty cell, which would look
	 * like missing data, and not a disabled control, which suggests it could be turned on.
	 */
</script>

<span class="na" aria-hidden="true">—</span><span class="sr-only">{t('table.notApplicable')}</span>

<style>
	.na {
		color: var(--text-muted);
	}
</style>
