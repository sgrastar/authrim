<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierProfileSummary
	} from '$lib/api/admin-identity-mapping';

	let loading = $state(true);
	let errorMessage = $state('');
	let profiles = $state<PersistentIdentifierProfileSummary[]>([]);

	onMount(() => {
		void loadProfiles();
	});

	async function loadProfiles() {
		loading = true;
		errorMessage = '';
		try {
			const response = await adminIdentityMappingAPI.listPersistentIdentifierProfiles();
			profiles = response.profiles;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load profiles';
		} finally {
			loading = false;
		}
	}

	function formatUsage(profile: PersistentIdentifierProfileSummary): string {
		return profile.usage.length > 0 ? profile.usage.join(', ') : 'No usages configured';
	}
</script>

<svelte:head>
	<title>Persistent IDs - Field Mapping</title>
</svelte:head>

<div class="persistent-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/field-mapping">Field Mappingに戻る</a>
			<p class="eyebrow">FIELD MAPPING</p>
			<h1>Persistent Identifier Profiles</h1>
			<p class="summary">
				SAML eduPersonTargetedID、SAML persistent NameID、OIDC pairwise subで共有する識別子生成profileを管理します。
			</p>
		</div>
		<div class="heading-actions">
			<button type="button" onclick={loadProfiles} disabled={loading}>更新</button>
			<a class="primary-action" href="/admin/field-mapping/persistent-identifiers/new">作成</a>
		</div>
	</div>

	{#if errorMessage}
		<p class="message error">{errorMessage}</p>
	{/if}

	<section class="panel">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">PROFILES</p>
				<h2>Profile inventory</h2>
			</div>
			<span class="count">{profiles.length}</span>
		</div>
		{#if loading}
			<div class="empty-state">Loading...</div>
		{:else if profiles.length === 0}
			<div class="empty-state">Persistent Identifier Profileはまだ登録されていません。</div>
		{:else}
			<div class="profile-list">
				{#each profiles as profile (profile.id)}
					<a class="profile-item" href={`/admin/field-mapping/persistent-identifiers/${profile.id}`}>
						<span>
							<strong>{profile.displayName}</strong>
							<small>{profile.profileKey}</small>
							<small>{profile.algorithm} / {profile.protocolScope} / {profile.audienceMode}</small>
							<small>{formatUsage(profile)}</small>
						</span>
						<span class="state">{profile.lifecycleState}</span>
					</a>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.persistent-page {
		padding: 2rem;
		color: var(--text-primary);
	}

	.page-heading {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1.5rem;
	}

	.back-link,
	.profile-item {
		color: inherit;
		text-decoration: none;
	}

	.eyebrow {
		margin: 0 0 0.35rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	h1,
	h2,
	.summary {
		margin: 0;
	}

	.summary {
		margin-top: 0.45rem;
		color: var(--text-secondary);
	}

	.heading-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	button,
	.primary-action {
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		background: var(--surface-subtle);
		color: var(--text-primary);
		padding: 0.7rem 1rem;
		font-weight: 700;
		cursor: pointer;
	}

	.primary-action {
		background: var(--accent-primary);
		border-color: var(--accent-primary);
		text-decoration: none;
	}

	.panel {
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		background: var(--surface-panel);
		padding: 1rem;
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.count,
	.state {
		border-radius: 999px;
		background: var(--surface-subtle);
		color: var(--text-secondary);
		padding: 0.25rem 0.6rem;
		font-size: 0.8rem;
		font-weight: 800;
	}

	.profile-list {
		display: grid;
		gap: 0.75rem;
	}

	.profile-item {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		padding: 1rem;
		background: var(--surface-subtle);
	}

	.profile-item:hover {
		border-color: var(--accent-primary);
	}

	.profile-item span:first-child {
		display: grid;
		gap: 0.3rem;
	}

	small {
		color: var(--text-secondary);
	}

	.empty-state,
	.message {
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		padding: 1rem;
		color: var(--text-secondary);
	}

	.message.error {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}
</style>
