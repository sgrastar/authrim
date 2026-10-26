<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { LogPager } from '$lib/admin/log-pager.svelte';
	import AdminPagination from './AdminPagination.svelte';
	let {
		pager,
		label,
		loading,
		reload
	}: { pager: LogPager; label: string; loading: boolean; reload: () => void } = $props();
</script>

{#if pager.info}
	<AdminPagination
		{label}
		info=""
		previousLabel={$LL.common_previous()}
		nextLabel={$LL.common_next()}
		hasPrevious={!loading && pager.hasPrevious}
		hasNext={!loading && pager.info.has_more}
		onPrevious={() => {
			pager.previous();
			reload();
		}}
		onNext={() => {
			pager.next();
			reload();
		}}
	/>
{/if}
