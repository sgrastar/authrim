<script lang="ts">
	import { onMount } from 'svelte';
	import { adminIdentityMappingAPI } from '$lib/api/admin-identity-mapping';
	import IdentityMappingFlowEditor from '$lib/components/identity-mapping/IdentityMappingFlowEditor.svelte';
	import { buildIdentityMappingFlowSamples } from '$lib/components/identity-mapping/flow-data';
	import type { MappingSample } from '$lib/components/identity-mapping/types';

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let flowSamples = $state<MappingSample[]>([]);
	let summary = $state({
		policies: 0,
		catalogs: 0,
		profiles: 0,
		federationTrustSources: 0
	});

	onMount(async () => {
		try {
			const [
				policies,
				catalogs,
				protocolSchemas,
				externalSchemas,
				federationTrustSources,
				schemaReadiness
			] = await Promise.all([
				adminIdentityMappingAPI.listPolicies(),
				adminIdentityMappingAPI.listCatalogs(),
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listFederationTrustSources(),
				adminIdentityMappingAPI.getSchemaReadiness()
			]);

			summary = {
				policies: policies.policies.length,
				catalogs: catalogs.catalogs.length,
				profiles: protocolSchemas.protocolSchemas.length + externalSchemas.externalSchemas.length,
				federationTrustSources: federationTrustSources.federationTrustSources.length
			};
			flowSamples = buildIdentityMappingFlowSamples({
				policies: policies.policies,
				catalogs: catalogs.catalogs,
				protocolSchemas: protocolSchemas.protocolSchemas,
				externalSchemas: externalSchemas.externalSchemas,
				schemaReadinessRows: schemaReadiness.rows
			});
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load identity mapping state';
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Identity Mapping - Authrim Admin</title>
</svelte:head>

<div class="identity-mapping-page">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Tier 2 Operations</p>
			<h1>Identity Mapping</h1>
			<p class="summary">
				Preview inbound sources, canonical identity targets, and outbound projections from one
				control-plane view.
			</p>
		</div>
		<div class="status-panel">
			<span class="status-dot"></span>
			<div>
				<strong
					>{loading
						? 'Loading control plane'
						: loadError
							? 'Preview fallback'
							: 'Control plane ready'}</strong
				>
				<small>
					{#if loading}
						Loading policy, catalog, profile, and federation trust summaries.
					{:else if loadError}
						{loadError}
					{:else}
						{summary.policies} policies, {summary.catalogs} catalogs, {summary.profiles} source/destination
						profiles.
					{/if}
				</small>
			</div>
		</div>
	</div>

	<IdentityMappingFlowEditor samples={flowSamples} {loading} {loadError} />

	<section class="operations-grid" aria-label="Identity mapping operations">
		<div class="operation-card">
			<p>Activation</p>
			<a href="/admin/identity-mapping/operations">{summary.policies} policy sets</a>
			<span
				>Policy activation, rollback, and degraded-state controls are grouped in the operations
				surface.</span
			>
		</div>
		<div class="operation-card">
			<p>Federation Trust</p>
			<a href="/admin/identity-mapping/federation-trust"
				>{summary.federationTrustSources} trust sources</a
			>
			<span>Trust sources and SAML aggregate entity selection are managed beside the editor.</span>
		</div>
		<div class="operation-card">
			<p>Profiles</p>
			<a href="/admin/identity-mapping/profiles">{summary.profiles} profiles</a>
			<span
				>Inbound sources and outbound destinations are prepared here before they are selected in the
				graph.</span
			>
		</div>
		<div class="operation-card">
			<p>Schema Readiness</p>
			<a href="/admin/identity-mapping/schema-readiness">Inventory gate</a>
			<span>Schema-readiness IDs and migration cross-references are shown before activation.</span>
		</div>
		<div class="operation-card">
			<p>Resolution</p>
			<a href="/admin/identity-mapping/resolution-center">Mapping Resolution Center</a>
			<span
				>Conflicts, missing mappings, linking decisions, consent blockers, and protected lifecycle
				actions are resolved outside the graph and filtered back into this editor.</span
			>
		</div>
		<div class="operation-card">
			<p>Consent Preview</p>
			<strong>Destination Profile first</strong>
			<span
				>Attribute release consent settings live with destination profiles; this editor previews
				challenge requirements and redacted release traces.</span
			>
		</div>
	</section>
</div>

<style>
	.identity-mapping-page {
		display: grid;
		gap: 18px;
	}

	.page-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		color: var(--text-primary);
		font-size: 28px;
		line-height: 1.2;
	}

	.summary {
		max-width: 760px;
		margin: 8px 0 0;
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
	}

	.status-panel {
		min-width: 260px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel strong,
	.status-panel small {
		display: block;
	}

	.status-panel strong {
		color: var(--text-primary);
		font-size: 13px;
	}

	.status-panel small {
		margin-top: 2px;
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1.35;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: #f59e0b;
		box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
	}

	.operations-grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 12px;
	}

	.operation-card {
		display: grid;
		gap: 6px;
		padding: 14px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.operation-card p {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
	}

	.operation-card strong {
		color: var(--text-primary);
		font-size: 15px;
	}

	.operation-card a {
		color: var(--color-primary);
		font-size: 15px;
		font-weight: 800;
		text-decoration: none;
	}

	.operation-card span {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	@media (max-width: 1400px) {
		.operations-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 980px) {
		.page-heading {
			display: grid;
		}

		.status-panel {
			min-width: 0;
		}

		.operations-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
