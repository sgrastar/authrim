<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingVersionSummary,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
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

<AdminPageShell>
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_policies_title()}
		description={$LL.admin_identity_mapping_policies_description()}
	/>

	<AdminSection title={$LL.admin_identity_mapping_policies_lists_title()}>
		{#snippet actions()}
			<button type="button" onclick={loadPolicies} disabled={loading}>
				{$LL.admin_identity_mapping_refresh()}
			</button>
		{/snippet}

		{#if loading}
			<div class="empty-state">{$LL.admin_identity_mapping_policies_loading()}</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<div class="policy-columns">
				<section class="policy-column-shell" aria-labelledby="source-policy-heading">
					<div class="column-toolbar">
						<h3 id="source-policy-heading">
							{$LL.admin_identity_mapping_policies_source_title()}
						</h3>
					</div>
					<div class="column-action-row">
						<a class="create-policy-link" href={newPolicyHref('source')}>
							{$LL.admin_identity_mapping_policies_create_source()}
						</a>
					</div>
					<div class="policy-column">
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
											<span
												class="state-pill"
												class:active={item.policy.lifecycleState === 'active'}
												>{item.policy.lifecycleState}</span
											>
											<span>{item.versionSummary}</span>
										</div>
									</a>
								{/each}
							</div>
						{/if}
					</div>
				</section>

				<section class="policy-column-shell" aria-labelledby="destination-policy-heading">
					<div class="column-toolbar">
						<h3 id="destination-policy-heading">
							{$LL.admin_identity_mapping_policies_destination_title()}
						</h3>
					</div>
					<div class="column-action-row">
						<a class="create-policy-link" href={newPolicyHref('destination')}>
							{$LL.admin_identity_mapping_policies_create_destination()}
						</a>
					</div>
					<div class="policy-column">
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
											<span
												class="state-pill"
												class:active={item.policy.lifecycleState === 'active'}
												>{item.policy.lifecycleState}</span
											>
											<span>{item.versionSummary}</span>
										</div>
									</a>
								{/each}
							</div>
						{/if}
					</div>
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

	h3 {
		font-size: 15px;
	}

	h4 {
		margin-top: 4px;
		font-size: 16px;
		line-height: 1.25;
	}

	.policy-item span,
	.column-empty {
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.45;
	}

	.empty-state,
	.policy-column {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	button {
		min-height: var(--control-height, 36px);
		padding: 0 12px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-weight: 800;
		cursor: pointer;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		padding: 18px;
		color: var(--color-text-muted);
	}

	.policy-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--policy-column-gap, 14px);
	}

	.policy-column-shell {
		min-width: 0;
		display: grid;
		gap: 8px;
	}

	.policy-column {
		min-width: 0;
		overflow: hidden;
	}

	.column-toolbar {
		display: block;
	}

	.column-action-row {
		display: flex;
		justify-content: flex-end;
	}

	.create-policy-link {
		min-height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		color: var(--color-text);
		background: var(--toolbar-control-bg, var(--color-surface));
		font-size: 12px;
		font-weight: 800;
		text-decoration: none;
		white-space: nowrap;
	}

	.create-policy-link:hover,
	.create-policy-link:focus-visible {
		background: var(--color-surface-muted);
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
		border-bottom: 1px solid color-mix(in srgb, var(--color-border) 72%, transparent);
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
		background: var(--color-surface-muted);
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
		border-radius: var(--status-badge-radius, 999px);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 12px;
		font-weight: 800;
	}

	.state-pill.active {
		color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
	}

	.column-empty {
		padding: 16px 14px;
	}

	@media (max-width: 900px) {
		.policy-item {
			display: grid;
		}

		.policy-meta {
			min-width: 0;
			justify-items: stretch;
			text-align: left;
		}

		.policy-columns {
			grid-template-columns: 1fr;
		}
	}
</style>
