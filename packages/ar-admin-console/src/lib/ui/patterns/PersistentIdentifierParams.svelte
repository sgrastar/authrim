<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import type {
		CsvImportKind,
		MaterialSummary,
		SaltResult,
		SaltSummary
	} from '#lib/api/identifier-materials.js';
	import Icon from '../icons/Icon.svelte';
	import Button from '../primitives/Button.svelte';
	import Select from '../primitives/Select.svelte';
	import TextField from '../primitives/TextField.svelte';
	import CsvImportDialog from './CsvImportDialog.svelte';
	import MaterialField from './MaterialField.svelte';
	import SaltImportDialog from './SaltImportDialog.svelte';
	import { useIdentifierMaterials } from './identifier-materials-context';
	import type { CsvImportResult } from './identifier-import-model';
	import {
		paramApplies,
		transformDef,
		type IdentifierMaterialKind,
		type TransformParam,
		type TransformStep
	} from './mapping-model';

	/**
	 * The settings of a persistent identifier step, in the mapping editor's step card. Each one
	 * is shown only while it applies (the digest for Shibboleth, the scope for the identifiers
	 * that are the same for every recipient, the store while stored identifiers are used…), the
	 * same `paramApplies` rule the rest of the editor and the validation use.
	 *
	 * What a setting names (a salt, an identifier source, a store, an exception list) is chosen
	 * from what was imported, with the import beside it: a salt in a dialog of its own (a
	 * secret), the others as CSV. What an import did is said under the settings.
	 */
	interface Props {
		step: TransformStep;
		/** One setting changed (the same call the editor's other settings make). */
		onchange: (name: string, value: string) => void;
	}

	let { step, onchange }: Props = $props();

	const client = useIdentifierMaterials();
	let gone = false;
	onDestroy(() => (gone = true));

	const params = $derived(
		transformDef(step.transform).params.filter((param) => paramApplies(param, step.params))
	);
	const valueOf = (param: TransformParam) =>
		String(step.params[param.key] ?? param.options?.[0] ?? '');

	// What was imported, by kind.
	let salts = $state<SaltSummary[]>([]);
	let lists = $state<Record<CsvImportKind, MaterialSummary[]>>({
		source: [],
		store: [],
		exceptions: []
	});
	let loading = $state(true);
	let loadFailed = $state(false);

	async function load() {
		loading = true;
		loadFailed = false;
		try {
			const [saltList, sources, stores, exceptions] = await Promise.all([
				client.salts(),
				client.sources(),
				client.stores(),
				client.exceptions()
			]);
			if (gone) return;
			salts = saltList;
			lists = { source: sources, store: stores, exceptions };
		} catch {
			if (!gone) loadFailed = true;
		} finally {
			if (!gone) loading = false;
		}
	}
	void load();

	/** The names to choose from; the one the step has now stays, listed or not. */
	function optionsFor(kind: IdentifierMaterialKind, current: string) {
		const names =
			kind === 'salt'
				? salts.map((salt) => ({
						value: salt.name,
						label: t('pid.optionSalt', { name: salt.name, fingerprint: salt.fingerprint })
					}))
				: lists[kind].map((item) => ({
						value: item.name,
						label: t('pid.optionCount', { name: item.name, count: item.count })
					}));
		return current && !names.some((option) => option.value === current)
			? [...names, { value: current, label: current }]
			: names;
	}

	// Imports: a salt in its own dialog, the rest as CSV.
	let saltDialog = $state(false);
	let csvKind = $state<CsvImportKind | null>(null);
	let result = $state('');

	const csvKindOf = (kind: IdentifierMaterialKind): CsvImportKind | null =>
		kind === 'salt' ? null : kind;

	function startImport(kind: IdentifierMaterialKind) {
		result = '';
		const csv = csvKindOf(kind);
		if (csv) csvKind = csv;
		else saltDialog = true;
	}

	function saltImported(done: SaltResult) {
		saltDialog = false;
		onchange('salt', done.name);
		result = t(`pid.result.salt.${done.outcome}` as MessageKey, {
			name: done.name,
			fingerprint: done.fingerprint
		});
		void load();
	}

	function csvImported(done: CsvImportResult) {
		csvKind = null;
		onchange(done.kind, done.name);
		if (done.kind === 'exceptions') {
			result =
				done.counts.rows === 0
					? t('pid.result.exceptionsEmptied', { name: done.name })
					: t('pid.result.exceptions', { name: done.name, ...done.counts });
		} else {
			result = t('pid.result.pairs', { name: done.name, ...done.counts });
		}
		void load();
	}

	const IMPORT_LABEL: Record<IdentifierMaterialKind, MessageKey> = {
		source: 'pid.importCsv',
		store: 'pid.importCsv',
		exceptions: 'pid.importCsv',
		salt: 'pid.importSalt'
	};
	const HINTS: Partial<Record<string, MessageKey>> = { salt: 'pid.hint.salt' };
</script>

{#each params as param (param.key)}
	{@const label = t(`pid.p.${param.key}` as MessageKey)}
	{#if param.material}
		<MaterialField
			{label}
			options={optionsFor(param.material, valueOf(param))}
			value={valueOf(param)}
			onchange={(value) => onchange(param.key, value)}
			importLabel={t(IMPORT_LABEL[param.material])}
			onimport={() => startImport(param.material!)}
			none={param.key === 'salt' || param.key === 'exceptions' ? t('pid.none') : undefined}
			hint={HINTS[param.key] ? t(HINTS[param.key]!) : undefined}
			{loading}
		/>
	{:else if param.options}
		<Select
			{label}
			size="sm"
			value={valueOf(param)}
			options={param.options.map((option) => ({
				value: option,
				label: t(`pid.o.${param.key}.${option}` as MessageKey)
			}))}
			onchange={(value) => onchange(param.key, value)}
		/>
	{:else}
		<TextField
			{label}
			size="sm"
			value={valueOf(param)}
			hint={param.key === 'scope' ? t('pid.hint.scope') : undefined}
			spellcheck="false"
			autocomplete="off"
			dir="ltr"
			oninput={(event) => onchange(param.key, event.currentTarget.value)}
		/>
	{/if}
{/each}

{#if loadFailed}
	<p class="note" role="status">
		<Icon name="warning" />{t('pid.loadFailed')}
		<Button size="sm" variant="ghost" onclick={load}>{t('pid.retry')}</Button>
	</p>
{/if}
{#if result}
	<p class="note" role="status"><Icon name="check" />{result}</p>
{/if}

<SaltImportDialog
	open={saltDialog}
	name={String(step.params.salt ?? '')}
	onimported={saltImported}
	oncancel={() => (saltDialog = false)}
/>
{#if csvKind}
	<CsvImportDialog
		open
		kind={csvKind}
		name={String(step.params[csvKind] ?? '')}
		onimported={csvImported}
		oncancel={() => (csvKind = null)}
	/>
{/if}

<style>
	.note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
		color: var(--text-muted);
	}
</style>
