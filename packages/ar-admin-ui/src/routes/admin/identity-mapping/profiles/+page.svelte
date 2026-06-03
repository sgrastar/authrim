<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingDestinationProfileSummary,
		type IdentityMappingSourceProfileSummary
	} from '$lib/api/admin-identity-mapping';

	type ProfileKind = 'inbound' | 'outbound' | 'template';

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
		profiles.filter((profile) => profile.kind === 'inbound' && profile.sourceProfileId)
	);
	const destinationProfileListItems = $derived(
		profiles.filter((profile) => profile.kind === 'outbound' && profile.destinationProfileId)
	);
	const inboundCount = $derived(profiles.filter((profile) => profile.kind === 'inbound').length);
	const outboundCount = $derived(profiles.filter((profile) => profile.kind === 'outbound').length);

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
			errorMessage = error instanceof Error ? error.message : 'Failed to load mapping profiles';
		} finally {
			loading = false;
		}
	}

	function sourceProfileToProfile(profile: IdentityMappingSourceProfileSummary): ProfileItem {
		return {
			id: `source:${profile.id}`,
			kind: 'inbound',
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
			kind: 'outbound',
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
			`/admin/identity-mapping/profiles/edit?kind=source&id=${encodeURIComponent(profile.sourceProfileId)}`
		);
	}

	function editDestinationProfile(profile: ProfileItem) {
		if (!profile.destinationProfileId) return;
		void goto(
			`/admin/identity-mapping/profiles/edit?kind=destination&id=${encodeURIComponent(profile.destinationProfileId)}`
		);
	}

	function createSourceProfile() {
		void goto('/admin/identity-mapping/profiles/edit?kind=source');
	}

	function createDestinationProfile() {
		void goto('/admin/identity-mapping/profiles/edit?kind=destination');
	}
</script>

<svelte:head>
	<title>Source & Destination Profiles - Authrim Admin</title>
</svelte:head>

<div class="profiles-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Source &amp; Destination Profiles</h1>
			<p class="summary">
				Register source profiles from CSV files or manual column definitions, then select them in
				the Flow Editor. SAML, SCIM, OIDC, VC, DID, MCP, A2A, and client-credential sources will use
				this same surface as their adapters are added.
			</p>
		</div>
		<div class="status-panel">
			<div>
				<span>Inbound</span>
				<strong>{inboundCount}</strong>
			</div>
			<div>
				<span>Outbound</span>
				<strong>{outboundCount}</strong>
			</div>
		</div>
	</div>

	<section class="profile-list-panel" aria-labelledby="profile-list-heading">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">Profile inventory</p>
				<h2 id="profile-list-heading">Source and destination profile lists</h2>
			</div>
			<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading source and destination profiles.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<div class="profile-list-columns">
				<section class="profile-list-column" aria-labelledby="source-profile-list-heading">
					<div class="column-heading">
						<h3 id="source-profile-list-heading">Source profiles</h3>
						<button type="button" onclick={createSourceProfile}>Create source profile</button>
					</div>
					{#if sourceProfileListItems.length === 0}
						<div class="column-empty">No source profiles.</div>
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
						<h3 id="destination-profile-list-heading">Destination profiles</h3>
						<button type="button" onclick={createDestinationProfile}>
							Create destination profile
						</button>
					</div>
					{#if destinationProfileListItems.length === 0}
						<div class="column-empty">No destination profiles.</div>
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
	</section>
</div>

<style>
	.profiles-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 10px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	h1,
	h2,
	h3,
	h4,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	h2,
	h3,
	h4 {
		color: var(--text-primary);
	}

	.summary {
		max-width: 840px;
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
	}

	.eyebrow,
	.status-panel span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.status-panel,
	.profile-list-panel,
	.empty-state {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		display: flex;
		gap: 16px;
		padding: 14px;
	}

	.status-panel div {
		display: grid;
		gap: 4px;
	}

	.status-panel strong {
		color: var(--text-primary);
		font-size: 18px;
	}

	.profile-list-panel {
		display: grid;
		gap: 16px;
		padding: 16px;
	}

	.empty-state {
		padding: 14px;
		color: var(--text-secondary);
	}

	.profile-list-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.profile-list-column {
		display: grid;
		align-content: start;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		overflow: hidden;
	}

	.column-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px;
		border-bottom: 1px solid var(--border-color);
	}

	.column-empty {
		padding: 18px 14px;
		color: var(--text-secondary);
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
		border-bottom: 1px solid var(--border-color);
		border-radius: 0;
		background: transparent;
		text-align: left;
	}

	.profile-list-item:hover,
	.profile-list-item:focus-visible {
		background: var(--bg-hover);
	}

	.profile-list-main,
	.profile-list-meta {
		display: grid;
		gap: 4px;
	}

	.profile-list-main span,
	.profile-list-meta span {
		color: var(--text-secondary);
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
		border-radius: 999px;
		background: var(--bg-hover);
		padding: 0 10px;
		font-weight: 800;
	}

	.state-pill.active {
		color: var(--color-success, #10b981);
	}

	button {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
		background: var(--bg-card);
		font-weight: 800;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (max-width: 1020px) {
		.page-heading,
		.panel-heading {
			display: grid;
		}

		.status-panel,
		.profile-list-columns {
			grid-template-columns: 1fr;
		}

		.profile-list-item {
			grid-template-columns: 1fr;
		}

		.profile-list-meta {
			justify-items: start;
		}
	}
</style>
