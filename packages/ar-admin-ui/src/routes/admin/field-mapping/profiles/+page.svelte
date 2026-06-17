<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingDestinationProfileSummary,
		type IdentityMappingSourceProfileSummary
	} from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	type ProfileKind = 'source' | 'destination' | 'template';

	interface ProfileItem {
		id: string;
		kind: ProfileKind;
		protocol: string;
		displayName: string;
		versionLabel: string;
		lifecycleState: string;
		source: string;
		sourceProfileId?: string;
		sourceProfileVersionId?: string;
		destinationProfileId?: string;
		destinationProfileVersionId?: string;
	}

	let profiles = $state<ProfileItem[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	onMount(() => {
		void loadProfiles();
	});

	const sourceProfileListItems = $derived(
		profiles.filter((profile) => profile.kind === 'source' && profile.sourceProfileId)
	);
	const destinationProfileListItems = $derived(
		profiles.filter((profile) => profile.kind === 'destination' && profile.destinationProfileId)
	);
	const sourceCount = $derived(profiles.filter((profile) => profile.kind === 'source').length);
	const destinationCount = $derived(
		profiles.filter((profile) => profile.kind === 'destination').length
	);

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const [loadedSourceProfiles, loadedDestinationProfiles] = await Promise.all([
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles()
			]);
			profiles = [
				...loadedSourceProfiles.sourceProfiles.map(sourceProfileToProfile),
				...loadedDestinationProfiles.destinationProfiles.map(destinationProfileToProfile)
			];
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_profiles_load_failed();
		} finally {
			loading = false;
		}
	}

	function sourceProfileToProfile(profile: IdentityMappingSourceProfileSummary): ProfileItem {
		return {
			id: `source:${profile.id}`,
			kind: 'source',
			protocol: profile.sourceType.toUpperCase(),
			displayName: profile.displayName,
			versionLabel: profile.version?.versionLabel ?? 'draft',
			lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
			source: profile.profileKey,
			sourceProfileId: profile.id,
			sourceProfileVersionId: profile.version?.id
		};
	}

	function destinationProfileToProfile(
		profile: IdentityMappingDestinationProfileSummary
	): ProfileItem {
		return {
			id: `destination:${profile.id}`,
			kind: 'destination',
			protocol: profile.destinationType.toUpperCase(),
			displayName: profile.displayName,
			versionLabel: profile.version?.versionLabel ?? 'draft',
			lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
			source: `${profile.ownerScopeType} / ${profile.profileKey}`,
			destinationProfileId: profile.id,
			destinationProfileVersionId: profile.version?.id
		};
	}

	function editSourceProfile(profile: ProfileItem) {
		if (!profile.sourceProfileId) return;
		void goto(
			`/admin/field-mapping/profiles/edit?kind=source&id=${encodeURIComponent(profile.sourceProfileId)}`
		);
	}

	function editDestinationProfile(profile: ProfileItem) {
		if (!profile.destinationProfileId) return;
		void goto(
			`/admin/field-mapping/profiles/edit?kind=destination&id=${encodeURIComponent(profile.destinationProfileId)}`
		);
	}

	function createSourceProfile() {
		void goto('/admin/field-mapping/profiles/edit?kind=source');
	}

	function createDestinationProfile() {
		void goto('/admin/field-mapping/profiles/edit?kind=destination');
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_profiles_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_profiles_title()}
		description={$LL.admin_identity_mapping_profiles_description()}
	>
		{#snippet actions()}
			<div class="status-panel">
				<div>
					<span>{$LL.admin_identity_mapping_source()}</span>
					<strong>{sourceCount}</strong>
				</div>
				<div>
					<span>{$LL.admin_identity_mapping_destination()}</span>
					<strong>{destinationCount}</strong>
				</div>
			</div>
		{/snippet}
	</AdminPageHeader>

	<AdminSection
		title={$LL.admin_identity_mapping_profiles_lists_title()}
		description={$LL.admin_identity_mapping_profiles_inventory()}
	>
		{#snippet actions()}
			<button type="button" onclick={loadProfiles} disabled={loading}>
				{$LL.admin_identity_mapping_refresh()}
			</button>
		{/snippet}

		{#if loading}
			<div class="empty-state">{$LL.admin_identity_mapping_profiles_loading()}</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<div class="profile-list-columns">
				<section class="profile-list-column" aria-labelledby="source-profile-list-heading">
					<div class="column-heading">
						<h3 id="source-profile-list-heading">
							{$LL.admin_identity_mapping_source_profiles()}
						</h3>
						<button type="button" onclick={createSourceProfile}>
							{$LL.admin_identity_mapping_profiles_create_source()}
						</button>
					</div>
					{#if sourceProfileListItems.length === 0}
						<div class="column-empty">{$LL.admin_identity_mapping_profiles_no_source()}</div>
					{:else}
						<div class="profile-list">
							{#each sourceProfileListItems as profile (profile.id)}
								<button
									type="button"
									class="profile-list-item"
									onclick={() => editSourceProfile(profile)}
								>
									<div class="profile-list-main">
										<h4>{profile.displayName}</h4>
										<span>{profile.protocol} / {profile.source}</span>
									</div>
									<div class="profile-list-meta">
										<span class="state-pill" class:active={profile.lifecycleState === 'active'}
											>{profile.lifecycleState}</span
										>
										<span>{profile.versionLabel}</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>

				<section class="profile-list-column" aria-labelledby="destination-profile-list-heading">
					<div class="column-heading">
						<h3 id="destination-profile-list-heading">
							{$LL.admin_identity_mapping_destination_profiles()}
						</h3>
						<button type="button" onclick={createDestinationProfile}>
							{$LL.admin_identity_mapping_profiles_create_destination()}
						</button>
					</div>
					{#if destinationProfileListItems.length === 0}
						<div class="column-empty">
							{$LL.admin_identity_mapping_profiles_no_destination()}
						</div>
					{:else}
						<div class="profile-list">
							{#each destinationProfileListItems as profile (profile.id)}
								<button
									type="button"
									class="profile-list-item"
									onclick={() => editDestinationProfile(profile)}
								>
									<div class="profile-list-main">
										<h4>{profile.displayName}</h4>
										<span>{profile.protocol} / {profile.source}</span>
									</div>
									<div class="profile-list-meta">
										<span class="state-pill" class:active={profile.lifecycleState === 'active'}
											>{profile.lifecycleState}</span
										>
										<span>{profile.versionLabel}</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	h3,
	h4 {
		margin: 0;
	}

	h3,
	h4 {
		color: var(--color-text);
	}

	.status-panel span {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
	}

	.status-panel,
	.empty-state {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.status-panel {
		display: flex;
		gap: 16px;
		padding: var(--profile-status-padding, 14px);
	}

	.status-panel div {
		display: grid;
		gap: 4px;
	}

	.status-panel strong {
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: var(--stat-value-size, 1.15rem);
	}

	.empty-state {
		padding: 14px;
		color: var(--color-text-muted);
	}

	.profile-list-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--profile-list-gap, 12px);
	}

	.profile-list-column {
		display: grid;
		align-content: start;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		overflow: hidden;
	}

	.column-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px;
		border-bottom: 1px solid var(--color-border);
	}

	.column-empty {
		padding: 18px 14px;
		color: var(--color-text-muted);
	}

	.profile-list {
		display: grid;
	}

	.profile-list-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 16px;
		align-items: center;
		width: 100%;
		min-height: 72px;
		padding: 14px;
		border: 0;
		border-bottom: 1px solid var(--color-border);
		border-radius: 0;
		background: transparent;
		color: var(--color-text);
		text-align: left;
	}

	.profile-list-item:hover,
	.profile-list-item:focus-visible {
		background: var(--color-surface-muted);
	}

	.profile-list-main,
	.profile-list-meta {
		display: grid;
		gap: 4px;
	}

	.profile-list-main span,
	.profile-list-meta span {
		color: var(--color-text-muted);
		font-size: 13px;
	}

	.profile-list-meta {
		justify-items: end;
	}

	.state-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 24px;
		border-radius: var(--status-badge-radius, 999px);
		background: var(--color-surface-muted);
		padding: 0 10px;
		font-weight: 800;
	}

	.state-pill.active {
		color: var(--color-success, #10b981);
	}

	button {
		min-height: var(--control-height, 34px);
		padding: 0 12px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text-muted);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-weight: 800;
		cursor: pointer;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (max-width: 1020px) {
		.status-panel,
		.profile-list-columns {
			grid-template-columns: 1fr;
			width: 100%;
		}

		.profile-list-item {
			grid-template-columns: 1fr;
		}

		.profile-list-meta {
			justify-items: start;
		}
	}
</style>
