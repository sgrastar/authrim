<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { AdminPageShell } from '$lib/components/admin';
	import { onMount } from 'svelte';

	const statementId = $derived($page.params.id ?? '');

	onMount(() => {
		if (!statementId) return;
		goto(`/admin/consent-statements/new?edit=${encodeURIComponent(statementId)}`, {
			replaceState: true
		});
	});
</script>

<AdminPageShell>
	<div class="admin-loading-placeholder"></div>
</AdminPageShell>
