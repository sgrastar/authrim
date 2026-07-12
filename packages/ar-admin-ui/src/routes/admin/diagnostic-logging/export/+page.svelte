<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import { LL } from '$i18n/i18n-svelte';

	onMount(() => {
		goto('/admin/diagnostic-logging');
	});
</script>

<svelte:head>
	<title>{$LL.admin_diagnostic_logging_export_redirect_title()}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_diagnostic_logging_export_redirect_heading()}
		description={$LL.admin_diagnostic_logging_export_redirect_description()}
	/>

	<div class="redirect-card">
		<a class="btn btn-primary" href="/admin/diagnostic-logging">
			{$LL.admin_diagnostic_logging_export_redirect_button()}
		</a>
	</div>
</AdminPageShell>

<style>
	.redirect-card {
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--control-height, 38px);
		padding: var(--button-padding, 8px 16px);
		border-radius: var(--control-radius, var(--radius-control));
		font-weight: 600;
		text-decoration: none;
	}

	.btn-primary {
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}
</style>
