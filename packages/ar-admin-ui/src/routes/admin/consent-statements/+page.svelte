<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement,
		type TenantConsentRequirement
	} from '$lib/api/admin-consent-statements';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	let statements = $state<ConsentStatement[]>([]);
	let requirements = $state<TenantConsentRequirement[]>([]);
	let loading = $state(true);
	let error = $state('');
	const samlAttributeReleaseConfirmationCategory = 'saml_attribute_release_confirmation';

	onMount(() => {
		loadStatements();
	});

	async function loadStatements() {
		loading = true;
		error = '';
		try {
			const [statementResult, requirementResult] = await Promise.all([
				adminConsentStatementsAPI.listStatements(),
				adminConsentStatementsAPI.listRequirements()
			]);
			statements = statementResult.statements || [];
			requirements = requirementResult.requirements || [];
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_load();
		} finally {
			loading = false;
		}
	}

	function openStatement(statementId: string) {
		goto(`/admin/consent-statements/${encodeURIComponent(statementId)}`);
	}

	function getRequirementForStatement(statementId: string): TenantConsentRequirement | undefined {
		return requirements.find((req) => req.statement_id === statementId);
	}

	function formatDate(ts: number): string {
		if (!ts) return '-';
		return new Date(ts).toLocaleDateString();
	}

	function localText(key: string): string {
		const ja = getLocale() === 'ja';
		const labels: Record<string, { ja: string; en: string }> = {
			samlCategory: { ja: 'SAML属性送信確認', en: 'SAML attribute release confirmation' },
			createNew: { ja: '新規作成', en: 'New' }
		};
		return ja ? labels[key]?.ja || key : labels[key]?.en || key;
	}

	function getCategoryLabel(category: string): string {
		switch (normalizeCategory(category)) {
			case 'terms_of_service':
				return $LL.admin_consent_category_terms_of_service();
			case 'privacy_policy':
				return $LL.admin_consent_category_privacy_policy();
			case samlAttributeReleaseConfirmationCategory:
				return localText('samlCategory');
			default:
				return $LL.admin_consent_category_custom();
		}
	}

	function normalizeCategory(category: string): string {
		return category === 'terms_of_service' ||
			category === 'privacy_policy' ||
			category === samlAttributeReleaseConfirmationCategory
			? category
			: 'custom';
	}
</script>

<svelte:head>
	<title>{$LL.admin_consent_statements_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_consent_statements_title()}
		description={$LL.admin_consent_statements_list_description()}
	>
		{#snippet actions()}
			<a href="/admin/consent-statements/new" class="btn btn-primary">
				<i class="i-ph-plus" aria-hidden="true"></i>
				{localText('createNew')}
			</a>
		{/snippet}
	</AdminPageHeader>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
			<p>{$LL.admin_consent_statements_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<AdminSection>
			<div class="statement-table">
				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_consent_statements_slug()}</th>
							<th>{$LL.admin_consent_statements_category()}</th>
							<th>{$LL.admin_consent_requirements_title()}</th>
							<th>{$LL.admin_consent_statements_active()}</th>
							<th class="optional-column">{$LL.admin_consent_statements_created()}</th>
						</tr>
					</thead>
					<tbody>
						{#each statements as statement (statement.id)}
							<tr
								data-clickable="true"
								onclick={() => openStatement(statement.id)}
								onkeydown={(event) => event.key === 'Enter' && openStatement(statement.id)}
								tabindex="0"
								role="button"
							>
								<td>
									<code class="admin-code">{statement.slug}</code>
									{#if statement.processing_purpose}
										<div class="statement-purpose">{statement.processing_purpose}</div>
									{/if}
								</td>
								<td>
									<span class="status-badge">{getCategoryLabel(statement.category)}</span>
								</td>
								<td>
									{#if getRequirementForStatement(statement.id)}
										<span class="status-badge" data-state="active">
											{getRequirementForStatement(statement.id)?.is_required
												? $LL.admin_consent_requirements_required()
												: $LL.admin_consent_requirements_optional()}
										</span>
									{:else}
										<span class="admin-muted">
											{$LL.admin_consent_requirements_not_configured()}
										</span>
									{/if}
								</td>
								<td>
									<span
										class="status-badge"
										data-state={statement.is_active ? 'active' : 'inactive'}
									>
										{statement.is_active
											? $LL.admin_consent_statements_active()
											: $LL.admin_consent_statements_inactive()}
									</span>
								</td>
								<td class="admin-muted nowrap optional-column"
									>{formatDate(statement.created_at)}</td
								>
							</tr>
						{:else}
							<tr>
								<td colspan="5">
									<div class="empty-state">
										<p class="empty-state-description">{$LL.admin_consent_statements_empty()}</p>
										<div class="empty-state-actions">
											<a href="/admin/consent-statements/new" class="btn btn-primary">
												{localText('createNew')}
											</a>
										</div>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.statement-purpose {
		margin-top: 4px;
		max-width: 680px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.status-badge[data-state='active'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}

	.status-badge[data-state='inactive'] {
		color: var(--color-text-muted);
	}

	.empty-state {
		padding: 28px;
		text-align: center;
	}

	.empty-state-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
	}

	.empty-state-description {
		margin: 0 0 14px;
		color: var(--color-text-muted);
	}

	@media (max-width: 720px) {
		.statement-table :global(.admin-data-table) {
			min-width: 0;
		}

		.statement-table :global(.optional-column) {
			display: none;
		}
	}
</style>
