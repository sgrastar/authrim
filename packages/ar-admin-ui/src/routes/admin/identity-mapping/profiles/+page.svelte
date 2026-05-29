<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingExternalSchemaSummary,
		type IdentityMappingProtocolSchemaSummary,
		type IdentityMappingTemplateSummary
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
	}

	let profiles = $state<ProfileItem[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let activeKind = $state<ProfileKind | 'all'>('all');
	const profileKinds: Array<ProfileKind | 'all'> = ['all', 'inbound', 'outbound', 'template'];

	onMount(() => {
		void loadProfiles();
	});

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const [protocolSchemas, externalSchemas, templates] = await Promise.all([
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listTemplates()
			]);
			profiles = [
				...protocolSchemas.protocolSchemas.map(protocolSchemaToProfile),
				...externalSchemas.externalSchemas.map(externalSchemaToProfile),
				...templates.templates.map(templateToProfile)
			];
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load mapping profiles';
		} finally {
			loading = false;
		}
	}

	const visibleProfiles = $derived(
		activeKind === 'all' ? profiles : profiles.filter((profile) => profile.kind === activeKind)
	);
	const inboundCount = $derived(profiles.filter((profile) => profile.kind === 'inbound').length);
	const outboundCount = $derived(profiles.filter((profile) => profile.kind === 'outbound').length);

	function protocolSchemaToProfile(schema: IdentityMappingProtocolSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: ['saml', 'oidc'].includes(schema.protocol.toLowerCase()) ? 'outbound' : 'inbound',
			protocol: schema.protocol,
			displayName: schema.displayName,
			versionLabel: schema.versionLabel,
			lifecycleState: schema.lifecycleState,
			source: schema.schemaKey
		};
	}

	function externalSchemaToProfile(schema: IdentityMappingExternalSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: 'inbound',
			protocol: schema.sourceType,
			displayName: schema.displayName,
			versionLabel: schema.versionLabel,
			lifecycleState: schema.lifecycleState,
			source: schema.sourceKey
		};
	}

	function templateToProfile(template: IdentityMappingTemplateSummary): ProfileItem {
		return {
			id: template.id,
			kind: 'template',
			protocol: template.protocol,
			displayName: template.displayName,
			versionLabel: template.templateKey,
			lifecycleState: template.lifecycleState,
			source: template.templateKey
		};
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
				Prepare inbound adapters and outbound destinations before selecting them in the Flow Editor.
				SAML, OIDC, SCIM, CSV, and future sources share this registration surface.
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

	<section class="profiles-panel">
		<div class="panel-heading">
			<div class="filter-bar" aria-label="Profile filters">
				{#each profileKinds as kind (kind)}
					<button
						type="button"
						class:active={activeKind === kind}
						onclick={() => (activeKind = kind)}
					>
						{kind}
					</button>
				{/each}
			</div>
			<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading source and destination profiles.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else if visibleProfiles.length === 0}
			<div class="empty-state">No profiles match this filter.</div>
		{:else}
			<div class="profile-grid">
				{#each visibleProfiles as profile (profile.id)}
					<article>
						<div class="profile-heading">
							<span>{profile.kind}</span>
							<strong>{profile.lifecycleState}</strong>
						</div>
						<h2>{profile.displayName}</h2>
						<p>{profile.protocol} / {profile.source}</p>
						<small>{profile.versionLabel}</small>
					</article>
				{/each}
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
	.panel-heading,
	.profile-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow,
	.status-panel span,
	.profile-heading span,
	.profile-grid small {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	h2,
	.status-panel strong,
	.profile-heading strong {
		color: var(--text-primary);
	}

	h2 {
		font-size: 16px;
		line-height: 1.35;
	}

	.summary,
	.profile-grid p {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 780px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.profiles-panel,
	.empty-state,
	.profile-grid article {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 260px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong {
		display: block;
		margin-top: 4px;
		font-size: 22px;
	}

	.profiles-panel {
		display: grid;
		gap: 14px;
		padding: 16px;
	}

	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
		background: var(--bg-card);
		font-weight: 800;
		text-transform: capitalize;
	}

	button.active {
		color: var(--text-primary);
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		padding: 18px;
		color: var(--text-secondary);
	}

	.profile-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.profile-grid article {
		display: grid;
		gap: 8px;
		padding: 14px;
	}

	.profile-heading strong {
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-muted);
		font-size: 12px;
	}

	@media (max-width: 1100px) {
		.profile-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 780px) {
		.page-heading,
		.panel-heading,
		.status-panel,
		.profile-grid {
			display: grid;
			grid-template-columns: 1fr;
		}

		.status-panel {
			min-width: 0;
		}
	}
</style>
