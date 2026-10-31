<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		type Schema,
		type SchemaSettingClient,
		type UsageBinding
	} from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import { FAILURE_KEY } from './labels';

	/**
	 * Deleting an attribute and every value people saved for it. It cannot be undone, so the key is
	 * typed to confirm. If something still relies on it the API refuses and says what; if some
	 * values could not be deleted the attribute is left marked as failed.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		schema: Schema;
		/** People who have a value, as the detail read it (-1: unknown). */
		userCount: number;
		open: boolean;
		oncancel: () => void;
		ondeleted: () => void;
		/** Turned off instead of deleted. */
		ondeactivated: () => void;
		/** The outcome is not known (it stopped half-way, or no answer came): read the attribute again. */
		onfailed: (message: string) => void;
	}

	let {
		client,
		tenantId,
		schema,
		userCount,
		open,
		oncancel,
		ondeleted,
		ondeactivated,
		onfailed
	}: Props = $props();

	let typed = $state('');
	let submitted = $state(false);
	let busy = $state(false);
	let error = $state('');
	let blocking = $state<UsageBinding[]>([]);
	let turningOff = $state(false);

	$effect(() => {
		if (!open) return;
		typed = '';
		submitted = false;
		error = '';
		blocking = [];
	});

	const mismatch = $derived(typed !== schema.fieldKey);
	const message = $derived(
		mismatch && (typed !== '' || submitted)
			? t('ss.delete.confirmType', { key: schema.fieldKey })
			: undefined
	);

	/** The way out of a slow delete: stop using it and keep the values, which can be undone. */
	async function turnOff() {
		turningOff = true;
		error = '';
		try {
			await client.update(tenantId, schema.id, { isActive: false });
			ondeactivated();
		} catch (failure) {
			error = t(FAILURE_KEY[failureOf(failure).kind]);
		} finally {
			turningOff = false;
		}
	}

	async function submit() {
		submitted = true;
		if (mismatch) return;
		busy = true;
		error = '';
		blocking = [];
		try {
			await client.remove(tenantId, schema.id);
			ondeleted();
		} catch (failure) {
			const { kind, usage, detail } = failureOf(failure);
			error = t(FAILURE_KEY[kind]);
			if (kind === 'in_use')
				blocking = usage.filter((entry) => entry.protection === 'delete_blocked');
			// The API marks the attribute as failed when it stops half-way, and also when it
			// answers a plain 500 (or nothing came back): what state it is in is not known.
			if (kind === 'partial' || kind === 'failed') {
				if (detail) error = `${error} (${detail})`;
				onfailed(error);
			}
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	{open}
	title={t('ss.delete.title')}
	submitLabel={t('ss.delete.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<Callout tone="danger">
		{t('ss.delete.body')}
		{#if userCount >= 0}<br />{t('ss.delete.users', { count: userCount })}{/if}
	</Callout>
	<Callout tone="warning" title={t('ss.delete.slowTitle')}>
		<p class="slow">{t('ss.delete.slowBody')}</p>
		{#if schema.isActive}
			<Button size="sm" variant="secondary" loading={turningOff} onclick={turnOff}
				>{t('ss.delete.deactivateInstead')}</Button
			>
		{/if}
	</Callout>
	{#if blocking.length > 0}
		<ul class="blocking">
			{#each blocking as entry (entry.id)}
				<li><code>{entry.bindingType}</code> {entry.bindingId}</li>
			{/each}
		</ul>
	{/if}
	<TextRow
		label={t('ss.field.key')}
		hint={t('ss.delete.confirmType', { key: schema.fieldKey })}
		bind:value={typed}
		error={message}
		spellcheck={false}
		autocomplete="off"
	/>
</FormDialog>

<style>
	.slow {
		margin: 0 0 8px;
	}

	.blocking {
		margin: 0;
		padding-inline-start: 20px;
		font-size: var(--fs-small);
	}
</style>
