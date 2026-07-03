<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_resolution_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_identity_mapping_resolution_title()}
		description={$LL.admin_identity_mapping_resolution_description()}
	/>

	<AdminSection>
		<div class="empty-state">
			<strong>{$LL.admin_identity_mapping_resolution_no_items()}</strong>
			<span>{$LL.admin_identity_mapping_resolution_no_items_desc()}</span>
		</div>
	</AdminSection>
</AdminPageShell>

<style>
	.empty-state {
		display: grid;
		gap: 0.35rem;
		border: 1px dashed var(--color-border);
		border-radius: 8px;
		padding: 1rem;
		color: var(--color-text-muted);
	}

	.empty-state strong {
		color: var(--color-text);
	}
</style>
