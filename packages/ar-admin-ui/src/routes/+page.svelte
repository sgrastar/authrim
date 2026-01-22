<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	onMount(() => {
		// Redirect to admin dashboard
		goto('/admin', { replaceState: true });
	});
</script>

<svelte:head>
	<title>Authrim Admin</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
	<div class="text-center">
		<div class="i-ph-circle-notch w-8 h-8 animate-spin text-primary-600"></div>
		<p class="mt-4 text-gray-600 dark:text-gray-400">Redirecting to admin dashboard...</p>
	</div>
</div>
