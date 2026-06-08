<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFederationMetadataDocument,
		type IdentityMappingFederationTrustSourceSummary
	} from '$lib/api/admin-identity-mapping';
	import { adminSAMLAPI, type SAMLMetadataEntitySummary } from '$lib/api/admin-saml';
	import { LL } from '$i18n/i18n-svelte';

	let trustSources = $state<IdentityMappingFederationTrustSourceSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let selectedSourceId = $state<string | null>(null);
	let previewId = $state('');
	let entityQuery = $state('');
	let entityLoading = $state(false);
	let entityError = $state<string | null>(null);
	let aggregateEntities = $state<SAMLMetadataEntitySummary[]>([]);
	let metadataDocuments = $state<IdentityMappingFederationMetadataDocument[]>([]);
	let metadataLoading = $state(false);
	let metadataError = $state<string | null>(null);
	let loadedMetadataSourceId = $state<string | null>(null);

	onMount(() => {
		void loadTrustSources();
	});

	$effect(() => {
		if (selectedSourceId && selectedSourceId !== loadedMetadataSourceId) {
			void loadMetadataDocuments(selectedSourceId);
		}
	});

	async function loadTrustSources() {
		loading = true;
		errorMessage = null;
		try {
			const result = await adminIdentityMappingAPI.listFederationTrustSources();
			trustSources = result.federationTrustSources;
			loadedMetadataSourceId = null;
			selectedSourceId = trustSources[0]?.id ?? null;
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_trust_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadMetadataDocuments(trustSourceId: string) {
		metadataLoading = true;
		metadataError = null;
		loadedMetadataSourceId = trustSourceId;
		try {
			const result = await adminIdentityMappingAPI.listFederationMetadataDocuments(trustSourceId);
			if (loadedMetadataSourceId === trustSourceId) {
				metadataDocuments = result.federationMetadataDocuments;
			}
		} catch (error) {
			if (loadedMetadataSourceId === trustSourceId) {
				metadataError =
					error instanceof Error
						? error.message
						: $LL.admin_identity_mapping_trust_documents_load_failed();
				metadataDocuments = [];
			}
		} finally {
			if (loadedMetadataSourceId === trustSourceId) {
				metadataLoading = false;
			}
		}
	}

	async function loadAggregateEntities() {
		if (!previewId.trim()) {
			entityError = $LL.admin_identity_mapping_trust_preview_required();
			return;
		}
		entityLoading = true;
		entityError = null;
		try {
			const result = await adminSAMLAPI.listAggregatePreviewEntities(previewId.trim(), {
				query: entityQuery.trim() || undefined,
				limit: 25
			});
			aggregateEntities = result.entities;
		} catch (error) {
			entityError =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_trust_entities_load_failed();
		} finally {
			entityLoading = false;
		}
	}

	const selectedSource = $derived(
		trustSources.find((source) => source.id === selectedSourceId) ?? trustSources[0] ?? null
	);

	function payloadValue(source: IdentityMappingFederationTrustSourceSummary, key: string): string {
		const value = source.protocolPayload?.[key];
		return typeof value === 'string' ? value : $LL.admin_identity_mapping_trust_not_configured();
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_trust_head_title()}</title>
</svelte:head>

<div class="trust-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/field-mapping">{$LL.admin_identity_mapping_back()}</a>
			<p class="eyebrow">{$LL.admin_identity_mapping_title()}</p>
			<h1>{$LL.admin_identity_mapping_trust_title()}</h1>
			<p class="summary">
				{$LL.admin_identity_mapping_trust_description()}
			</p>
		</div>
		<div class="status-panel">
			<strong>{trustSources.length}</strong>
			<span>{$LL.admin_identity_mapping_trust_sources_count()}</span>
		</div>
	</div>

	<div class="trust-layout">
		<section class="source-list" aria-label={$LL.admin_identity_mapping_trust_sources_aria()}>
			<div class="panel-heading">
				<p class="eyebrow">{$LL.admin_identity_mapping_trust_sources()}</p>
				<button type="button" onclick={loadTrustSources} disabled={loading}>
					{$LL.admin_identity_mapping_refresh()}
				</button>
			</div>
			{#if loading}
				<div class="empty-state">{$LL.admin_identity_mapping_trust_loading()}</div>
			{:else if errorMessage}
				<div class="empty-state">{errorMessage}</div>
			{:else if trustSources.length === 0}
				<div class="empty-state">{$LL.admin_identity_mapping_trust_empty()}</div>
			{:else}
				{#each trustSources as source (source.id)}
					<button
						type="button"
						class:active={selectedSource?.id === source.id}
						onclick={() => (selectedSourceId = source.id)}
					>
						<span>{source.sourceType}</span>
						<strong>{source.displayName}</strong>
						<small>{source.lifecycleState}</small>
					</button>
				{/each}
			{/if}
		</section>

		<section class="detail-panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">{$LL.admin_identity_mapping_trust_detail()}</p>
					<h2>{selectedSource?.displayName ?? $LL.admin_identity_mapping_trust_select_source()}</h2>
				</div>
				{#if selectedSource}
					<strong class="badge">{selectedSource.lifecycleState}</strong>
				{/if}
			</div>

			{#if selectedSource}
				<div class="detail-grid">
					<div>
						<span>{$LL.admin_identity_mapping_trust_source_key()}</span>
						<strong>{selectedSource.sourceKey}</strong>
					</div>
					<div>
						<span>{$LL.admin_identity_mapping_trust_source_type()}</span>
						<strong>{selectedSource.sourceType}</strong>
					</div>
					<div>
						<span>{$LL.admin_identity_mapping_trust_policy()}</span>
						<strong>{payloadValue(selectedSource, 'policy')}</strong>
					</div>
					<div>
						<span>{$LL.admin_identity_mapping_trust_updated()}</span>
						<strong>{selectedSource.updatedAt ?? $LL.admin_identity_mapping_unknown()}</strong>
					</div>
				</div>
			{/if}

			<div class="aggregate-panel">
				<div>
					<p class="eyebrow">{$LL.admin_identity_mapping_trust_metadata_ledger()}</p>
					<h2>{$LL.admin_identity_mapping_trust_documents_title()}</h2>
				</div>
				{#if metadataLoading}
					<div class="empty-state">{$LL.admin_identity_mapping_trust_documents_loading()}</div>
				{:else if metadataError}
					<div class="empty-state">{metadataError}</div>
				{:else if metadataDocuments.length === 0}
					<div class="empty-state">{$LL.admin_identity_mapping_trust_documents_empty()}</div>
				{:else}
					<div class="document-list">
						{#each metadataDocuments as document (document.id)}
							<article>
								<div>
									<p>{document.documentType}</p>
									<h3>{document.sourceUrl ?? document.documentHash}</h3>
									<span>
										{document.validationState} /
										{$LL.admin_identity_mapping_entities_count({
											count: document.entitySummaries.length
										})}
									</span>
								</div>
								<strong>
									{document.validatedAt ??
										document.fetchedAt ??
										$LL.admin_identity_mapping_pending()}
								</strong>
							</article>
						{/each}
					</div>
				{/if}
			</div>

			<div class="aggregate-panel">
				<div>
					<p class="eyebrow">{$LL.admin_identity_mapping_trust_entity_selection()}</p>
					<h2>{$LL.admin_identity_mapping_trust_entity_title()}</h2>
				</div>
				<div class="aggregate-form">
					<label>
						<span>{$LL.admin_identity_mapping_trust_preview_id()}</span>
						<input
							bind:value={previewId}
							placeholder={$LL.admin_identity_mapping_trust_preview_placeholder()}
						/>
					</label>
					<label>
						<span>{$LL.admin_identity_mapping_trust_search()}</span>
						<input
							bind:value={entityQuery}
							placeholder={$LL.admin_identity_mapping_trust_search_placeholder()}
						/>
					</label>
					<button type="button" onclick={loadAggregateEntities} disabled={entityLoading}>
						{$LL.admin_identity_mapping_trust_load_entities()}
					</button>
				</div>
				{#if entityError}
					<div class="empty-state">{entityError}</div>
				{:else if aggregateEntities.length > 0}
					<div class="entity-list">
						{#each aggregateEntities as entity (entity.entityId)}
							<article>
								<div>
									<p>{entity.role}</p>
									<h3>{entity.displayName ?? entity.entityId}</h3>
									<span>{entity.entityId}</span>
								</div>
								<strong>
									{$LL.admin_identity_mapping_certs_count({
										count: entity.certificateCount
									})}
								</strong>
							</article>
						{/each}
					</div>
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.trust-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.document-list article,
	.entity-list article {
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
	.detail-grid span,
	.aggregate-form span,
	.entity-list p,
	.document-list p,
	.status-panel span {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	h2,
	h3,
	.detail-grid strong,
	.entity-list strong,
	.document-list strong,
	.source-list button strong,
	.status-panel strong {
		color: var(--text-primary);
	}

	h2 {
		font-size: 18px;
	}

	h3 {
		font-size: 15px;
	}

	.summary,
	.entity-list span,
	.document-list span,
	.source-list button small {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 760px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.source-list,
	.detail-panel,
	.empty-state,
	.detail-grid > div,
	.aggregate-panel,
	.document-list article,
	.entity-list article {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 180px;
		padding: 14px;
		text-align: right;
	}

	.status-panel strong {
		display: block;
		font-size: 24px;
	}

	.trust-layout {
		display: grid;
		grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
		gap: 14px;
	}

	.source-list,
	.detail-panel {
		padding: 14px;
	}

	button {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-weight: 800;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.source-list > button {
		width: 100%;
		height: auto;
		display: grid;
		justify-items: start;
		gap: 3px;
		margin-top: 8px;
		padding: 12px;
		text-align: left;
	}

	.source-list > button.active {
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	.badge {
		padding: 4px 9px;
		border-radius: 999px;
		color: #047857;
		background: rgba(16, 185, 129, 0.14);
		font-size: 12px;
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		margin-top: 14px;
	}

	.detail-grid > div,
	.aggregate-panel,
	.document-list article,
	.entity-list article,
	.empty-state {
		padding: 14px;
	}

	.aggregate-panel {
		display: grid;
		gap: 14px;
		margin-top: 14px;
	}

	.aggregate-form {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) auto;
		gap: 10px;
		align-items: end;
	}

	label {
		display: grid;
		gap: 6px;
	}

	input {
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-input);
	}

	.entity-list,
	.document-list {
		display: grid;
		gap: 10px;
	}

	@media (max-width: 1000px) {
		.page-heading,
		.trust-layout,
		.panel-heading,
		.aggregate-form,
		.detail-grid,
		.entity-list article {
			display: grid;
			grid-template-columns: 1fr;
		}

		.status-panel {
			min-width: 0;
			text-align: left;
		}
	}
</style>
