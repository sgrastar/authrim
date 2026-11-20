<script lang="ts">
	import type { Tenant } from '#lib/api/tenants.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import TenantPickerDialog from '#lib/pages/tenants/TenantPickerDialog.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import { useChangeMark } from '#lib/ui/save/save-scope.js';
	import { LIMITS, type LauncherEditorValue, type ProblemField } from './launcher-model';

	/**
	 * Whom a platform launcher is shared with, and whether tenants may change it. "Share with every
	 * tenant" and "Share with chosen tenants" exclude each other (neither: not shared yet). The
	 * chosen tenants are picked in a dialog (a table of the tenants with a checkbox each).
	 * "Tenants may change it" is on by default: off, tenants show it as it is and cannot hide it
	 * (a copy a tenant made is kept, unused).
	 */
	interface Props {
		value: LauncherEditorValue;
		loadTenants: (signal?: AbortSignal) => Promise<Tenant[]>;
		errors: Partial<Record<ProblemField, MessageKey>>;
		disabled?: boolean;
	}

	let { value = $bindable(), loadTenants, errors, disabled = false }: Props = $props();

	const changes = useChangeMark();
	const savedMode = $derived(changes.original('shareMode'));
	let picking = $state(false);
</script>

<Card title={t('ln.card.sharing')} info={t('ln.card.sharingInfo')}>
	<RowStack>
		<FieldRow label={t('ln.sharing.target')} align="text" plain>
			<div class="sharing-fields">
				<Checkbox
					{disabled}
					changed={savedMode !== undefined && (savedMode === 'all') !== (value.shareMode === 'all')}
					checked={value.shareMode === 'all'}
					onchange={(event) => (value.shareMode = event.currentTarget.checked ? 'all' : 'none')}
					>{t('ln.sharing.all')}</Checkbox
				>
				<Checkbox
					{disabled}
					changed={savedMode !== undefined &&
						(savedMode === 'selected') !== (value.shareMode === 'selected')}
					checked={value.shareMode === 'selected'}
					onchange={(event) =>
						(value.shareMode = event.currentTarget.checked ? 'selected' : 'none')}
					>{t('ln.sharing.selected')}</Checkbox
				>
				{#if value.shareMode === 'selected'}
					<div class="sharing-fields__tenants">
						<span
							class="sharing-fields__count"
							class:sharing-fields__count--error={!!errors.tenants}
						>
							{value.tenantIds.length > 0
								? t('ln.sharing.count', { n: value.tenantIds.length })
								: t('ln.sharing.none')}
						</span>
						<Button size="sm" icon="building" {disabled} onclick={() => (picking = true)}
							>{t('ln.sharing.choose')}</Button
						>
					</div>
					{#if errors.tenants}
						<p class="sharing-fields__error" role="alert">{t(errors.tenants)}</p>
					{/if}
				{/if}
				{#if value.shareMode === 'none'}
					<p class="sharing-fields__note">{t('ln.sharing.notShared')}</p>
				{/if}
			</div>
		</FieldRow>

		<CheckRow
			label={t('ln.sharing.change')}
			text={t('ln.sharing.changeAllowed')}
			description={t('ln.sharing.changeHint')}
			field="tenantChangeAllowed"
			{disabled}
			bind:checked={value.tenantChangeAllowed}
		/>
	</RowStack>
</Card>

<TenantPickerDialog
	open={picking}
	title={t('ln.sharing.pickTitle')}
	description={t('ln.sharing.pickBody')}
	selected={value.tenantIds}
	max={LIMITS.tenants}
	{loadTenants}
	onapply={(ids) => {
		value.tenantIds = ids;
		picking = false;
	}}
	oncancel={() => (picking = false)}
/>

<style>
	.sharing-fields {
		display: grid;
		gap: var(--space-related);
		justify-items: start;
		min-inline-size: 0;
	}

	.sharing-fields__tenants {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
		padding-inline-start: 28px;
	}

	.sharing-fields__count {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}

	.sharing-fields__count--error {
		color: var(--danger);
	}

	.sharing-fields__error,
	.sharing-fields__note {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.sharing-fields__error {
		color: var(--danger);
	}

	.sharing-fields__note {
		color: var(--text-muted);
	}
</style>
