<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierProfileSummary
	} from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';

	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let profiles = $state<PersistentIdentifierProfileSummary[]>([]);

	onMount(() => {
		void loadProfiles();
	});

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const response = await adminIdentityMappingAPI.listPersistentIdentifierProfiles();
			profiles = response.profiles;
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_persistent_load_failed();
		} finally {
			loading = false;
		}
	}

	function formatUsage(profile: PersistentIdentifierProfileSummary): string {
		return profile.usage.length > 0
			? profile.usage.join(', ')
			: $LL.admin_identity_mapping_persistent_usage_empty();
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_persistent_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_persistent_title()}
		description={$LL.admin_identity_mapping_persistent_description()}
	>
		{#snippet actions()}
			<div class="persistent-actions">
				<button type="button" onclick={loadProfiles} disabled={loading}>
					{$LL.admin_identity_mapping_refresh()}
				</button>
				<a class="primary-action" href="/admin/field-mapping/persistent-identifiers/new">
					{$LL.admin_identity_mapping_persistent_create()}
				</a>
			</div>
		{/snippet}
	</AdminPageHeader>

	<AdminSection
		title={$LL.admin_identity_mapping_persistent_inventory()}
		description={$LL.admin_identity_mapping_persistent_description()}
	>
		{#if loading}
			<div class="empty-state">{$LL.admin_identity_mapping_persistent_loading()}</div>
		{:else if errorMessage}
			<div class="empty-state error">{errorMessage}</div>
		{:else if profiles.length === 0}
			<div class="empty-state">{$LL.admin_identity_mapping_persistent_empty()}</div>
		{:else}
			<div class="persistent-list">
				{#each profiles as profile (profile.id)}
					<a
						class="persistent-item"
						href={`/admin/field-mapping/persistent-identifiers/${profile.id}`}
					>
						<div class="persistent-item__main">
							<strong>{profile.displayName}</strong>
							<span>{profile.profileKey}</span>
							<span>{formatUsage(profile)}</span>
						</div>
						<div class="persistent-item__meta">
							<span>{profile.lifecycleState}</span>
							<span>{$LL.admin_identity_mapping_persistent_algorithm()}: {profile.algorithm}</span>
							<span>{$LL.admin_identity_mapping_persistent_scope()}: {profile.protocolScope}</span>
							<span>{$LL.admin_identity_mapping_persistent_audience()}: {profile.audienceMode}</span
							>
							{#if profile.secretRef}
								<span>{$LL.admin_identity_mapping_persistent_secret()}: {profile.secretRef}</span>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	.persistent-actions {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	button,
	.primary-action {
		border: 1px solid var(--button-border, var(--color-border));
		border-radius: var(--button-radius, 8px);
		background: var(--button-secondary-bg, var(--color-surface));
		color: var(--button-secondary-color, var(--color-text));
		padding: var(--button-padding-y, 0.65rem) var(--button-padding-x, 0.95rem);
		font: inherit;
		font-weight: var(--button-font-weight, 700);
		text-decoration: none;
		cursor: pointer;
	}

	button:disabled {
		cursor: wait;
		opacity: 0.65;
	}

	.primary-action {
		background: var(--button-primary-bg, var(--color-accent));
		border-color: var(--button-primary-border, var(--color-accent));
		color: var(--button-primary-color, #fff);
	}

	.empty-state {
		border: 1px solid var(--color-border);
		border-radius: var(--card-radius, 8px);
		background: var(--color-surface);
		color: var(--color-text-muted);
		padding: 18px;
	}

	.empty-state.error {
		color: var(--color-danger);
		border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
	}

	.persistent-list {
		display: grid;
		gap: 10px;
	}

	.persistent-item {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.4fr);
		gap: 18px;
		align-items: start;
		border: 1px solid var(--color-border);
		border-radius: var(--card-radius, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		padding: 16px;
		text-decoration: none;
	}

	.persistent-item:hover {
		border-color: var(--color-accent);
	}

	.persistent-item__main,
	.persistent-item__meta {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.persistent-item__main strong {
		font-size: 1rem;
	}

	.persistent-item__main span,
	.persistent-item__meta span {
		color: var(--color-text-muted);
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}

	@media (max-width: 760px) {
		.persistent-item {
			grid-template-columns: 1fr;
		}
	}
</style>
