<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import type { FederationStatusKey } from './federation-model';

	/** Where a federation stands, in one badge: in use, set up but not started, run out, failing, or retired. */
	interface Props {
		status: FederationStatusKey;
	}
	let { status }: Props = $props();
	const TONE = {
		active: 'success',
		draft: 'neutral',
		expired: 'danger',
		refreshFailed: 'warning',
		retired: 'neutral'
	} as const;
</script>

<Badge tone={TONE[status]} dot>{t(`sf.fed.status.${status}`)}</Badge>
