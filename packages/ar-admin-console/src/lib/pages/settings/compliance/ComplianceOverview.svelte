<script lang="ts">
	import type { ComplianceClient, ComplianceStatus } from '$lib/api/compliance';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { formatNumber } from '$lib/ui/format';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import {
		checkFacts,
		duration,
		frameworkLabel,
		label,
		statusLabel,
		statusTone,
		timeText
	} from './labels';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	let status = $state<ComplianceStatus | null>(null);
	let failed = $state(false);

	async function load() {
		failed = false;
		status = null;
		try {
			status = await client.status(tenantId);
		} catch {
			// The status answers 503 when any fact behind it cannot be read.
			failed = true;
		}
	}

	$effect(() => {
		void load();
	});

	const num = (value: number) => formatNumber(value, i18n.locale);
</script>

{#if failed}
	<Callout tone="warning" live>
		{t('cmp.unavailable')}
		<Button variant="secondary" size="sm" onclick={load}>{t('cmp.retry')}</Button>
	</Callout>
{:else if !status}
	<LoadingState label={t('cmp.loading')} />
{:else}
	<div class="overview">
		<Card title={t('cmp.overall')} description={t('cmp.overall.desc')}>
			<div class="overall">
				<Badge tone={statusTone(status.overall_status)} dot>
					{statusLabel(status.overall_status)}
				</Badge>
				<span class="muted">
					{t('cmp.asOf', { at: timeText(status.generated_at) })}
				</span>
			</div>
		</Card>

		<Card title={t('cmp.frameworks')} description={t('cmp.frameworks.desc')}>
			<div class="frameworks">
				{#each status.frameworks as framework (framework.framework)}
					<div class="framework">
						<div class="framework__head">
							<h3>{frameworkLabel(framework.framework)}</h3>
							<Badge tone={statusTone(framework.status)}>{statusLabel(framework.status)}</Badge>
						</div>
						<p class="muted">
							{t('cmp.frameworkCounts', {
								compliant: framework.compliant_checks,
								warning: framework.warning_checks,
								nonCompliant: framework.non_compliant_checks
							})}
						</p>
					</div>
				{/each}
			</div>
		</Card>

		<Card title={t('cmp.checks')} flush>
			<DataTable
				caption={t('cmp.checks')}
				columns={[
					{ key: 'check', label: t('cmp.col.check'), width: '32%' },
					{ key: 'facts', label: t('cmp.col.facts') },
					{ key: 'frameworks', label: t('cmp.col.frameworks'), width: '22%' }
				]}
				rows={status.checks}
				rowKey={(check) => check.id}
			>
				{#snippet cell(check, column)}
					{#if column.key === 'check'}
						<div class="stack">
							<strong>{label('cmp.check.', check.id)}</strong>
							<Badge tone={statusTone(check.status)}>{statusLabel(check.status)}</Badge>
						</div>
					{:else if column.key === 'facts'}
						{checkFacts(check)}
					{:else}
						<span class="muted">{check.frameworks.map(frameworkLabel).join(', ')}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Card>

		<Card title={t('cmp.mfa')}>
			<DetailList columns={3}>
				<DetailItem label={t('cmp.mfa.admins')}>
					{num(status.mfa.admins.with_passkey)} / {num(status.mfa.admins.admins)}
				</DetailItem>
				<DetailItem label={t('cmp.mfa.users')}>
					{num(status.mfa.users.with_any)} / {num(status.mfa.users.users)}
					<div class="muted">
						{t('cmp.mfa.usersDetail', {
							passkey: status.mfa.users.with_passkey,
							totp: status.mfa.users.with_totp,
							guests: status.mfa.users.guests
						})}
					</div>
				</DetailItem>
				<DetailItem label={t('cmp.mfa.enforced')}>
					{status.mfa.enforcement.enforced ? t('cmp.yes') : t('cmp.no')}
				</DetailItem>
				<DetailItem label={t('cmp.audit.eventRetention')}>
					{status.audit_log.event_retention_days === null
						? '—'
						: duration(status.audit_log.event_retention_days * 86_400)}
				</DetailItem>
				<DetailItem label={t('cmp.audit.piiRetention')}>
					{status.audit_log.pii_retention_days === null
						? '—'
						: duration(status.audit_log.pii_retention_days * 86_400)}
				</DetailItem>
				<DetailItem label={t('cmp.accessControl')}>
					{num(status.access_control.users_with_roles)}
				</DetailItem>
				<DetailItem label={t('cmp.pendingDeletions')}>
					{num(status.accounts.pending_deletions)}
				</DetailItem>
			</DetailList>
		</Card>
	</div>
{/if}

<style>
	.overview {
		display: flex;
		flex-direction: column;
		gap: var(--space-section);
	}

	.overall {
		display: flex;
		align-items: center;
		gap: var(--space-related);
		flex-wrap: wrap;
	}

	.frameworks {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: var(--space-grid);
	}

	.framework {
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		padding: var(--box-pad);
	}

	.framework__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
	}

	.framework__head h3 {
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.framework p {
		margin: var(--space-related) 0 0;
	}

	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
