<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * What repeated failed sign-ins do: the tenant's setting, shown as it is set. A lock is the
	 * account's, so it is set once for the tenant (Attack protection), not per Flow.
	 */
	const PROTECTION = '/admin/authentication/protection';
	/** The setting's default (rate_limit.auth_max_failed_attempts). */
	const DEFAULT_LIMIT = 5;

	const { failedSignInLimit } = useFlowResources();
	let limit = $state<number | null>(failedSignInLimit ? null : DEFAULT_LIMIT);
	let unreadable = $state(false);
	const controller = new AbortController();
	onMount(async () => {
		if (!failedSignInLimit) return;
		try {
			limit = await failedSignInLimit(controller.signal);
		} catch {
			unreadable = true;
		}
	});
	onDestroy(() => controller.abort());
</script>

<Callout tone="info">
	<p class="note">
		{unreadable
			? t('af.info.failedSignInsUnknown')
			: limit === null
				? t('common.loading')
				: t('af.info.failedSignIns', { count: limit })}
	</p>
	<Link href={PROTECTION} standalone>{t('af.info.failedSignInsLink')}</Link>
</Callout>

<style>
	.note {
		margin: 0 0 4px;
	}
</style>
