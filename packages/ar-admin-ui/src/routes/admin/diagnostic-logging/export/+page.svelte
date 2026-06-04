<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';

	onMount(() => {
		goto('/admin/diagnostic-logging');
	});
</script>

<svelte:head>
	<title>{$LL.admin_diagnostic_logging_export_redirect_title()}</title>
</svelte:head>

<div class="container">
	<div class="card">
		<h1>{$LL.admin_diagnostic_logging_export_redirect_heading()}</h1>
		<p>{$LL.admin_diagnostic_logging_export_redirect_description()}</p>
		<a class="btn btn-primary" href="/admin/diagnostic-logging">
			{$LL.admin_diagnostic_logging_export_redirect_button()}
		</a>
	</div>
</div>
