<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingSchemaReadinessRow,
		type IdentityMappingSchemaReadinessSummary
	} from '$lib/api/admin-identity-mapping';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	type GateFilter = IdentityMappingSchemaReadinessRow['gateState'] | 'all';

	let rows = $state<IdentityMappingSchemaReadinessRow[]>([]);
	let summary = $state<IdentityMappingSchemaReadinessSummary>({
		total: 0,
		pass: 0,
		attention: 0,
		blocked: 0,
		deferred: 0
	});
	let activeStatus = $state<GateFilter>('all');
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	onMount(() => {
		void loadSchemaReadiness();
	});

	async function loadSchemaReadiness() {
		loading = true;
		errorMessage = null;
		try {
			const result = await adminIdentityMappingAPI.getSchemaReadiness();
			rows = result.rows;
			summary = result.summary;
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_schema_load_failed();
		} finally {
			loading = false;
		}
	}

	const visibleRows = $derived(
		activeStatus === 'all' ? rows : rows.filter((row) => row.gateState === activeStatus)
	);
	const statuses = $derived(['all', ...new Set(rows.map((row) => row.gateState))] as const);
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_schema_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_schema_title()}
		description={$LL.admin_identity_mapping_schema_description()}
	>
		{#snippet actions()}
			<div class="status-panel">
				<div>
					<span>{$LL.admin_identity_mapping_schema_blocked()}</span>
					<strong>{summary.blocked}</strong>
				</div>
				<div>
					<span>{$LL.admin_identity_mapping_schema_deferred()}</span>
					<strong>{summary.deferred}</strong>
				</div>
				<div>
					<span>{$LL.admin_identity_mapping_schema_attention()}</span>
					<strong>{summary.attention}</strong>
				</div>
				<div>
					<span>{$LL.admin_identity_mapping_schema_total()}</span>
					<strong>{summary.total}</strong>
				</div>
			</div>
		{/snippet}
	</AdminPageHeader>

	<AdminSection>
		<AdminToolbar>
			<div class="filter-segment" aria-label={$LL.admin_identity_mapping_schema_filters_aria()}>
				{#each statuses as status (status)}
					<button
						type="button"
						class:active={activeStatus === status}
						onclick={() => (activeStatus = status)}
					>
						{status.replace('_', ' ')}
					</button>
				{/each}
			</div>
			<button type="button" onclick={loadSchemaReadiness} disabled={loading}>
				{$LL.admin_identity_mapping_refresh()}
			</button>
		</AdminToolbar>

		{#if loading}
			<div class="empty-state">{$LL.admin_identity_mapping_schema_loading()}</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<AdminDataTable width="xwide">
				<thead>
					<tr>
						<th>{$LL.admin_identity_mapping_schema_inventory_id()}</th>
						<th>{$LL.admin_identity_mapping_schema_area()}</th>
						<th>{$LL.admin_identity_mapping_schema_status()}</th>
						<th>{$LL.admin_identity_mapping_schema_gate_state()}</th>
						<th>{$LL.admin_identity_mapping_schema_object()}</th>
						<th>{$LL.admin_identity_mapping_schema_connection()}</th>
						<th>{$LL.admin_identity_mapping_schema_gate()}</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleRows as row (row.id)}
						<tr>
							<td><strong>{row.id}</strong></td>
							<td>{row.area}</td>
							<td><span class="status status-{row.status}">{row.status}</span></td>
							<td>
								<span class="status status-{row.gateState}">{row.gateState}</span>
							</td>
							<td>
								{#if row.schemaObject}
									<code>{row.schemaObject}</code>
									<small>
										{row.schemaPresent
											? $LL.admin_identity_mapping_present()
											: $LL.admin_identity_mapping_missing()}
									</small>
								{:else}
									<span class="muted">{$LL.admin_identity_mapping_service_adapter()}</span>
								{/if}
							</td>
							<td>{row.expectedConnectionPr}</td>
							<td>{row.gate}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
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
		min-width: 260px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong {
		display: block;
		margin-top: 4px;
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: var(--stat-value-size, 1.35rem);
	}

	.empty-state {
		padding: 18px;
		border: 1px dashed var(--color-border);
		color: var(--color-text-muted);
	}

	.filter-segment {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		min-height: var(--control-height, 34px);
		padding: 0 12px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text-muted);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-weight: 800;
		text-transform: capitalize;
		cursor: pointer;
	}

	button.active {
		color: var(--color-text);
		border-color: var(--color-accent);
		background: var(--color-surface-muted);
	}

	td strong {
		color: var(--color-text);
	}

	td small {
		display: block;
		margin-top: 4px;
		color: var(--color-text-muted);
		font-size: 12px;
	}

	code {
		color: var(--color-text);
		font-size: 12px;
	}

	.muted {
		color: var(--color-text-muted);
	}

	.status {
		display: inline-flex;
		padding: 4px 8px;
		border-radius: 999px;
		background: var(--color-surface-muted);
		color: var(--color-text);
		font-weight: 800;
	}

	.status-closed,
	.status-tested,
	.status-api_connected,
	.status-repo_connected,
	.status-service_connected,
	.status-pass {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.status-deferred,
	.status-reserved_planned,
	.status-adapter_deferred {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 16%, transparent);
	}

	.status-attention,
	.status-schema_added,
	.status-existing_to_migrate,
	.status-breaking_planned {
		color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 16%, transparent);
	}

	.status-blocked {
		color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
	}

	@media (max-width: 900px) {
		.status-panel {
			display: grid;
		}

		.status-panel {
			min-width: 0;
		}
	}
</style>
