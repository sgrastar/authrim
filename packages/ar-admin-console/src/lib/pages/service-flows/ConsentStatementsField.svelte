<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ConsentStatementListItem } from '#lib/api/consent-statements.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import {
		consentEntries,
		consentLabel,
		consentValue,
		isChoosable,
		MAX_CONSENT_STATEMENTS,
		moveEntry,
		type ConsentEntry
	} from './consent-field-model';
	import { useFlowResources } from './flow-resources-context';
	import { statementName } from '#lib/pages/customization/statements/statement-model.js';

	/**
	 * The consent statements a flow asks, in the order they are shown: chosen from the tenant's
	 * statements (only those turned on and with a published version), each required or optional.
	 * A statement that is no longer there (deleted or retired) stays in the list, flagged, so it
	 * can be removed. Statements are made and changed on their own pages: links lead there.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		/** `<statement id>:required` / `<statement id>:optional`, in order. */
		value: string[];
		onchange: (value: string[]) => void;
		/** The flow cannot hold this setting: shown, not editable (with `unavailableReason`). */
		unavailable?: boolean;
		unavailableReason?: string;
	}

	let {
		label,
		hint,
		required = false,
		value,
		onchange,
		unavailable = false,
		unavailableReason
	}: Props = $props();

	const STATEMENTS = '/admin/customization/statements';
	const { consentStatements: client } = useFlowResources();
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let items = $state<ConsentStatementListItem[]>([]);
	const controller = new AbortController();
	onDestroy(() => controller.abort());

	async function load() {
		phase = 'loading';
		try {
			const list = await client.list(controller.signal);
			if (controller.signal.aborted) return;
			items = list;
			phase = 'ready';
		} catch {
			if (!controller.signal.aborted) phase = 'failed';
		}
	}
	onMount(() => void load());

	const entries = $derived(consentEntries(value));
	const full = $derived(entries.length >= MAX_CONSENT_STATEMENTS);
	const offered = $derived(
		items
			.filter(
				(item) => isChoosable(item) && !entries.some((e) => e.statementId === item.statement.id)
			)
			.map((item) => ({
				value: item.statement.id,
				label: statementName(item.titles, i18n.locale, item.statement.slug)
			}))
	);
	let picked = $state('');

	function set(next: ConsentEntry[]) {
		onchange(consentValue(next));
	}
	function add() {
		if (!picked || full) return;
		set([...entries, { statementId: picked, required: true }]);
		picked = '';
	}
</script>

<fieldset class="consent" disabled={unavailable}>
	<legend class="consent__label">
		{label}{#if required}<span class="consent__req" aria-hidden="true">*</span>{/if}
	</legend>
	{#if hint}<p class="consent__hint">{hint}</p>{/if}
	{#if unavailable}
		<Callout tone="warning">{unavailableReason ?? t('af.consent.unavailable')}</Callout>
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<Callout tone="warning">
			{t('af.consent.loadFailed')}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{/if}
	{#if !unavailable && phase !== 'loading'}
		{#if entries.length === 0}
			<p class="consent__empty">{t('af.consent.empty')}</p>
		{:else}
			<ol class="consent__rows">
				{#each entries as entry, index (entry.statementId)}
					{@const info = consentLabel(entry.statementId, items, i18n.locale)}
					{@const known = phase === 'failed' || info.known}
					<li class="consent__row">
						<div class="consent__line" role="group" aria-label={info.name}>
							<span class="consent__name" class:is-id={!info.known && phase === 'ready'}
								>{info.name}</span
							>
							<Checkbox
								checked={entry.required}
								onchange={(event) =>
									set(
										entries.map((other, i) =>
											i === index ? { ...other, required: event.currentTarget.checked } : other
										)
									)}>{t('af.consent.required')}</Checkbox
							>
							<IconButton
								size="sm"
								icon="arrowUp"
								label={t('af.consent.moveUp', { name: info.name })}
								disabled={index === 0}
								onclick={() => set(moveEntry(entries, index, -1))}
							/>
							<IconButton
								size="sm"
								icon="arrowDown"
								label={t('af.consent.moveDown', { name: info.name })}
								disabled={index === entries.length - 1}
								onclick={() => set(moveEntry(entries, index, 1))}
							/>
							<IconButton
								size="sm"
								icon="close"
								label={t('af.consent.remove', { name: info.name })}
								onclick={() => set(entries.filter((_, i) => i !== index))}
							/>
						</div>
						{#if phase === 'ready' && !known}
							<Badge tone="danger">{t('af.consent.unknown')}</Badge>
						{:else if phase === 'ready' && !info.choosable}
							<Badge tone="warning">{t('af.consent.unpublished')}</Badge>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
		{#if phase === 'ready'}
			{#if full}
				<p class="consent__hint">{t('af.consent.max', { n: MAX_CONSENT_STATEMENTS })}</p>
			{:else if offered.length > 0}
				<div class="consent__add">
					<Select
						label={t('af.consent.add')}
						placeholder={t('af.consent.addPlaceholder')}
						options={offered}
						bind:value={picked}
					/>
					<Button disabled={!picked} onclick={add}>{t('af.consent.add')}</Button>
				</div>
			{:else if entries.length === 0}
				<p class="consent__hint">{t('af.consent.none')}</p>
			{/if}
		{/if}
		<div class="consent__links">
			<Link href={STATEMENTS} standalone>{t('af.consent.manage')}</Link>
			<Link href={`${STATEMENTS}/new`} standalone>{t('af.consent.create')}</Link>
		</div>
	{/if}
</fieldset>

<style>
	.consent {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.consent__label {
		padding: 0;
		font-weight: var(--fw-semibold);
	}

	.consent__req {
		margin-inline-start: var(--space-related);
		color: var(--danger);
	}

	.consent__hint,
	.consent__empty {
		margin: 0;
		color: var(--text-secondary);
	}

	.consent__rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.consent__row {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		padding: var(--space-related);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.consent__line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	.consent__name {
		flex: 1 1 12rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.consent__name.is-id {
		font-family: var(--font-mono);
	}

	.consent__add {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-related);
	}

	.consent__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}
</style>
