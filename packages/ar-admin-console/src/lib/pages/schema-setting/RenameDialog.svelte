<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		type RenameResult,
		type Schema,
		type SchemaSettingClient
	} from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
	import { FAILURE_KEY, KEY_PROBLEM_KEY } from './labels';
	import { checkKey } from './schema-validation';

	/**
	 * Changing the key of an attribute. The values people saved under the old key move to the new
	 * one, one by one; if some cannot move, the attribute is left marked as failed, to be retried.
	 * Mappings that point at the old key are not changed.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		schema: Schema;
		/** People who have a value, as the detail read it (-1: unknown). */
		userCount: number;
		open: boolean;
		oncancel: () => void;
		onrenamed: (result: RenameResult) => void;
		/** The outcome is not known (it stopped half-way, or no answer came): read the attribute again. */
		onfailed: (message: string) => void;
	}

	let { client, tenantId, schema, userCount, open, oncancel, onrenamed, onfailed }: Props =
		$props();

	let key = $state('');
	let reserved = $state<ReadonlySet<string>>(new Set());
	let taken = $state<ReadonlySet<string>>(new Set());
	let submitted = $state(false);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		key = '';
		submitted = false;
		error = '';
		void (async () => {
			try {
				const [names, active] = await Promise.all([
					client.reservedNames(tenantId),
					client.list(tenantId, { isActive: true, limit: 100 })
				]);
				reserved = new Set(names);
				taken = new Set(active.schemas.map((entry) => entry.fieldKey));
			} catch {
				// The API judges.
			}
		})();
	});

	const problem = $derived(checkKey(key, { reserved, taken, current: schema.fieldKey }));
	const message = $derived(
		problem && (key !== '' || submitted) ? t(KEY_PROBLEM_KEY[problem], { key }) : undefined
	);

	async function submit() {
		submitted = true;
		if (problem) return;
		busy = true;
		error = '';
		try {
			onrenamed(await client.rename(tenantId, schema.id, key));
		} catch (failure) {
			const { kind, detail } = failureOf(failure);
			error = t(FAILURE_KEY[kind]);
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
	title={t('ss.rename.title')}
	submitLabel={t('ss.rename.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<p class="current">{t('ss.rename.current')}: <code>{schema.fieldKey}</code></p>
	<TextRow
		label={t('ss.rename.newKey')}
		hint={t('ss.field.keyHint')}
		required
		bind:value={key}
		error={message}
		spellcheck={false}
		autocomplete="off"
	/>
	{#if userCount >= 0}
		<p class="count">{t('ss.rename.affected', { count: userCount })}</p>
	{/if}
	<Callout tone="warning">{t('ss.rename.warn')}</Callout>
</FormDialog>

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
	}

	.current,
	.count {
		margin: 0;
	}

	.count {
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
