<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingVersionSummary,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import { LL } from '$i18n/i18n-svelte';

	type PolicySide = 'source' | 'destination';

	interface PolicyListItem {
		side: PolicySide;
		policy: IdentityMappingFieldMappingSetSummary;
		version: IdentityMappingFieldMappingVersionSummary;
		href: string;
		profileSummary: string;
		versionSummary: string;
	}

	let policies = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let fieldMappingVersionsByFieldMappingSetId = $state<
		Record<string, IdentityMappingFieldMappingVersionSummary[]>
	>({});
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	onMount(() => {
		void loadPolicies();
	});

	async function loadPolicies() {
		loading = true;
		errorMessage = null;
		try {
			const policyResult = await adminIdentityMappingAPI.listFieldMappingSets();
			policies = policyResult.fieldMappingSets;
			const versionPairs = await Promise.all(
				policyResult.fieldMappingSets.map(
					async (policy) =>
						[
							policy.id,
							(await adminIdentityMappingAPI.listFieldMappingVersions(policy.id))
								.fieldMappingVersions
						] as const
				)
			);
			fieldMappingVersionsByFieldMappingSetId = Object.fromEntries(versionPairs);
		} catch (error) {
			errorMessage =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_policies_load_failed();
		} finally {
			loading = false;
		}
	}

	const sourcePolicyItems = $derived(buildPolicyItems('source'));
	const destinationPolicyItems = $derived(buildPolicyItems('destination'));

	function buildPolicyItems(side: PolicySide): PolicyListItem[] {
		return policies
			.map((policy) => {
				const versions = versionsForSide(policy, side);
				const version = preferredVersion(versions);
				if (!version) {
					return null;
				}
				return {
					side,
					policy,
					version,
					href: editPolicyHref(policy, version, side),
					profileSummary: profileSummary(version, side),
					versionSummary: `${version.versionLabel} / ${version.lifecycleState}`
				} satisfies PolicyListItem;
			})
			.filter((item): item is PolicyListItem => item !== null);
	}

	function versionsForSide(
		policy: IdentityMappingFieldMappingSetSummary,
		side: PolicySide
	): IdentityMappingFieldMappingVersionSummary[] {
		return (fieldMappingVersionsByFieldMappingSetId[policy.id] ?? []).filter((version) =>
			versionSupportsSide(version, side)
		);
	}

	function versionSupportsSide(
		version: IdentityMappingFieldMappingVersionSummary,
		side: PolicySide
	): boolean {
		if (version.directions) {
			return side === 'source'
				? Boolean(version.directions.source)
				: Boolean(version.directions.destination);
		}
		const hasSourceProfiles = (version.sourceProfileIds?.length ?? 0) > 0;
		const hasDestinationProfiles = (version.destinationProfileIds?.length ?? 0) > 0;
		if (hasSourceProfiles || hasDestinationProfiles) {
			return side === 'source' ? hasSourceProfiles : hasDestinationProfiles;
		}
		return true;
	}

	function preferredVersion(
		versions: IdentityMappingFieldMappingVersionSummary[]
	): IdentityMappingFieldMappingVersionSummary | null {
		return (
			versions.find(
				(version) =>
					version.lifecycleState === 'active' || version.latestSnapshot?.lifecycleState === 'active'
			) ??
			versions.find((version) => version.lifecycleState === 'published') ??
			versions.find((version) => version.lifecycleState === 'draft') ??
			versions[0] ??
			null
		);
	}

	function editPolicyHref(
		policy: IdentityMappingFieldMappingSetSummary,
		version: IdentityMappingFieldMappingVersionSummary,
		side: PolicySide
	): string {
		const params = new URLSearchParams({
			policyId: policy.id,
			versionId: version.id,
			direction: side
		});
		return `/admin/field-mapping/edit?${params.toString()}`;
	}

	function newPolicyHref(side: PolicySide): string {
		const params = new URLSearchParams({ direction: side });
		return `/admin/field-mapping/edit?${params.toString()}`;
	}

	function profileSummary(
		version: IdentityMappingFieldMappingVersionSummary,
		side: PolicySide
	): string {
		const count =
			side === 'source'
				? (version.sourceProfileIds?.length ?? 0)
				: (version.destinationProfileIds?.length ?? 0);
		return side === 'source'
			? $LL.admin_identity_mapping_source_profile_count({
					count,
					plural: count === 1 ? '' : 's'
				})
			: $LL.admin_identity_mapping_destination_profile_count({
					count,
					plural: count === 1 ? '' : 's'
				});
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_policies_head_title()}</title>
</svelte:head>

<div class="operations-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/field-mapping">{$LL.admin_identity_mapping_back()}</a>
			<p class="eyebrow">{$LL.admin_identity_mapping_title()}</p>
			<h1>{$LL.admin_identity_mapping_policies_title()}</h1>
			<p class="summary">
				{$LL.admin_identity_mapping_policies_description()}
			</p>
		</div>
	</div>

	<section class="policy-panel">
		<div class="panel-heading">
			<div>
				<h2>{$LL.admin_identity_mapping_policies_lists_title()}</h2>
			</div>
			<button type="button" onclick={loadPolicies} disabled={loading}>
				{$LL.admin_identity_mapping_refresh()}
			</button>
		</div>

		{#if loading}
			<div class="empty-state">{$LL.admin_identity_mapping_policies_loading()}</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else if policies.length === 0}
			<div class="empty-state">{$LL.admin_identity_mapping_policies_empty()}</div>
		{:else}
			<div class="policy-columns">
				<section class="policy-column" aria-labelledby="source-policy-heading">
					<div class="column-heading">
						<h3 id="source-policy-heading">
							{$LL.admin_identity_mapping_policies_source_title()}
						</h3>
						<a class="create-policy-link" href={newPolicyHref('source')}>
							{$LL.admin_identity_mapping_policies_create_source()}
						</a>
					</div>
					{#if sourcePolicyItems.length === 0}
						<div class="column-empty">{$LL.admin_identity_mapping_policies_no_source()}</div>
					{:else}
						<div class="policy-list">
							{#each sourcePolicyItems as item (`${item.side}-${item.policy.id}-${item.version?.id ?? 'latest'}`)}
								<a class="policy-item" href={item.href}>
									<div>
										<h4>{item.policy.displayName}</h4>
										<span>{item.policy.description ?? item.profileSummary}</span>
									</div>
									<div class="policy-meta">
										<span class="state-pill" class:active={item.policy.lifecycleState === 'active'}
											>{item.policy.lifecycleState}</span
										>
										<span>{item.versionSummary}</span>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</section>

				<section class="policy-column" aria-labelledby="destination-policy-heading">
					<div class="column-heading">
						<h3 id="destination-policy-heading">
							{$LL.admin_identity_mapping_policies_destination_title()}
						</h3>
						<a class="create-policy-link" href={newPolicyHref('destination')}>
							{$LL.admin_identity_mapping_policies_create_destination()}
						</a>
					</div>
					{#if destinationPolicyItems.length === 0}
						<div class="column-empty">
							{$LL.admin_identity_mapping_policies_no_destination()}
						</div>
					{:else}
						<div class="policy-list">
							{#each destinationPolicyItems as item (`${item.side}-${item.policy.id}-${item.version?.id ?? 'latest'}`)}
								<a class="policy-item" href={item.href}>
									<div>
										<h4>{item.policy.displayName}</h4>
										<span>{item.policy.description ?? item.profileSummary}</span>
									</div>
									<div class="policy-meta">
										<span class="state-pill" class:active={item.policy.lifecycleState === 'active'}
											>{item.policy.lifecycleState}</span
										>
										<span>{item.versionSummary}</span>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</section>
</div>

<style>
	.operations-page {
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
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow {
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
	h4,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
		line-height: 1.2;
	}

	h2,
	h3,
	h4 {
		color: var(--text-primary);
	}

	h2 {
		font-size: 18px;
	}

	h3 {
		font-size: 15px;
	}

	h4 {
		margin-top: 4px;
		font-size: 16px;
		line-height: 1.25;
	}

	.summary,
	.policy-item span,
	.column-empty {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 760px;
		margin-top: 8px;
		font-size: 14px;
	}

	.policy-panel,
	.empty-state,
	.policy-column {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.policy-panel {
		padding: 16px;
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

	.empty-state {
		margin-top: 14px;
		padding: 18px;
		color: var(--text-secondary);
	}

	.policy-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		margin-top: 14px;
	}

	.policy-column {
		min-width: 0;
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

	.create-policy-link {
		min-height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-size: 12px;
		font-weight: 800;
		text-decoration: none;
		white-space: nowrap;
	}

	.create-policy-link:hover,
	.create-policy-link:focus-visible {
		background: var(--bg-muted);
		outline: none;
	}

	.policy-list {
		display: grid;
	}

	.policy-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 13px 14px;
		border-bottom: 1px solid color-mix(in srgb, var(--border-color) 72%, transparent);
		color: inherit;
		text-decoration: none;
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}

	.policy-item:last-child {
		border-bottom: 0;
	}

	.policy-item:hover,
	.policy-item:focus-visible {
		background: var(--bg-muted);
		outline: none;
	}

	.policy-item h4,
	.policy-item span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.policy-meta {
		min-width: 142px;
		display: grid;
		justify-items: end;
		gap: 6px;
		text-align: right;
	}

	.state-pill {
		width: fit-content;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-muted);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 800;
	}

	.state-pill.active {
		color: #047857;
		background: rgba(16, 185, 129, 0.14);
	}

	.column-empty {
		padding: 16px 14px;
	}

	@media (max-width: 900px) {
		.page-heading,
		.panel-heading,
		.policy-item {
			display: grid;
		}

		.policy-meta {
			min-width: 0;
			justify-items: stretch;
			text-align: left;
		}

		.column-heading {
			display: grid;
		}

		.policy-columns {
			grid-template-columns: 1fr;
		}
	}
</style>
