<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import {
		failureOf,
		type Preset,
		type PresetResult,
		type SchemaSettingClient
	} from '$lib/api/schema-setting';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import SelectRow from '$lib/ui/patterns/SelectRow.svelte';
	import { TYPE_KEY } from './labels';

	/**
	 * Adding the base attributes from a preset (the OIDC standard claims, SCIM, eduPerson…). The
	 * ones that exist already are shown as added and cannot be chosen; the rest are chosen to
	 * start with. What is added is a base attribute: its key, label, type and personal-data flag
	 * are locked.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		open: boolean;
		oncancel: () => void;
		onapplied: (result: PresetResult) => void;
	}

	let { client, tenantId, open, oncancel, onapplied }: Props = $props();

	let presets = $state<Preset[]>([]);
	let existing = $state<ReadonlySet<string>>(new Set());
	let presetId = $state('');
	let chosen = $state<string[]>([]);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');

	const preset = $derived(presets.find((candidate) => candidate.id === presetId));
	const missing = $derived(
		preset ? preset.fields.filter((field) => !existing.has(field.fieldKey)) : []
	);

	$effect(() => {
		if (!open) return;
		error = '';
		loading = true;
		void (async () => {
			try {
				const result = await client.presets(tenantId);
				presets = result.presets;
				existing = new Set(result.existingKeys);
				select(result.presets[0]?.id ?? '');
			} catch {
				error = t('ss.preset.failed');
			} finally {
				loading = false;
			}
		})();
	});

	function select(id: string) {
		presetId = id;
		const next = presets.find((candidate) => candidate.id === id);
		chosen = next
			? next.fields.filter((f) => !existing.has(f.fieldKey)).map((f) => f.fieldKey)
			: [];
	}

	function toggle(fieldKey: string, on: boolean) {
		chosen = on ? [...chosen, fieldKey] : chosen.filter((other) => other !== fieldKey);
	}

	async function submit() {
		if (!preset || chosen.length === 0) return;
		busy = true;
		error = '';
		try {
			onapplied(await client.applyPreset(tenantId, preset.id, chosen));
		} catch (failure) {
			error = failureOf(failure).kind === 'invalid' ? t('ss.preset.failed') : t('ss.error.failed');
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	{open}
	title={t('ss.preset.title')}
	description={t('ss.preset.note')}
	submitLabel={t('ss.preset.submit')}
	busy={busy || loading}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<SelectRow
		label={t('ss.preset.choose')}
		value={presetId}
		onchange={select}
		hint={preset?.description}
		options={presets.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
	/>
	{#if preset}
		<fieldset class="fields">
			<legend>{t('ss.preset.fields')}</legend>
			{#if missing.length === 0}
				<p class="none">{t('ss.preset.none')}</p>
			{/if}
			{#each preset.fields as field (field.fieldKey)}
				{@const added = existing.has(field.fieldKey)}
				<div class="field">
					<Checkbox
						checked={added || chosen.includes(field.fieldKey)}
						disabled={added}
						onchange={(event) => toggle(field.fieldKey, event.currentTarget.checked)}
					>
						{field.label}
						<code>{field.fieldKey}</code>
					</Checkbox>
					<span class="marks">
						<Badge>{t(TYPE_KEY[field.type])}</Badge>
						{#if field.isPii}<Badge tone="info">{t('ss.pii.yes')}</Badge>{/if}
						{#if added}<Badge tone="neutral">{t('ss.preset.exists')}</Badge>{/if}
					</span>
				</div>
			{/each}
		</fieldset>
	{/if}
</FormDialog>

<style>
	.fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.fields legend {
		margin-block-end: var(--space-related);
		padding: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.field {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related) var(--space-field);
		align-items: center;
		justify-content: space-between;
	}

	.marks {
		display: inline-flex;
		gap: 6px;
	}

	code {
		margin-inline-start: 6px;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.none {
		margin: 0;
		color: var(--text-muted);
	}
</style>
