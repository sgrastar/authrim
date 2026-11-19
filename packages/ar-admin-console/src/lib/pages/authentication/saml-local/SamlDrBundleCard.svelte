<script lang="ts">
	import type { SamlSettings, SamlSettingsClient } from '#lib/api/saml-settings.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import FileDrop from '#lib/ui/patterns/FileDrop.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import {
		DR_BUNDLE_PASSPHRASE_MIN_LENGTH,
		downloadText,
		passphraseProblem
	} from './local-signing-model';

	/**
	 * The signing keys of both roles as one passphrase-encrypted file: written out for safe
	 * keeping, or read back into this tenant (which the Admin API protects with a step-up). The
	 * passphrase is typed twice and never kept after an operation.
	 */
	interface Props {
		settings: SamlSettings;
		client: SamlSettingsClient;
		canExport: boolean;
		canImport: boolean;
		busy: boolean;
		onbusy: (busy: boolean) => void;
		onchanged: (settings: SamlSettings) => void;
		onerror: (message: string) => void;
	}

	let { settings, client, canExport, canImport, busy, onbusy, onchanged, onerror }: Props =
		$props();

	let passphrase = $state('');
	let confirmation = $state('');
	let files = $state<File[]>([]);
	let exporting = $state(false);
	let importing = $state(false);
	let confirming = $state(false);

	const problem = $derived(passphraseProblem(passphrase, confirmation));
	const problemText = $derived(
		problem === 'short'
			? t('sl.dr.passphrase.short', { min: DR_BUNDLE_PASSPHRASE_MIN_LENGTH })
			: problem === 'mismatch'
				? t('sl.dr.passphrase.mismatch')
				: ''
	);
	/** Said only once something was typed. */
	const showProblem = $derived(
		passphrase.length > 0 && confirmation.length > 0 && problem !== null
	);
	const ready = $derived(problem === null);

	function clear() {
		passphrase = '';
		confirmation = '';
	}

	function cancelled(error: unknown): boolean {
		return error instanceof Error && error.name === 'NotAllowedError';
	}

	function report(error: unknown) {
		if (cancelled(error)) return;
		if (error instanceof ApiError && error.forbidden) onerror(t('sl.dr.forbidden'));
		else onerror(error instanceof Error ? error.message : String(error));
	}

	async function exportBundle() {
		if (!ready) return;
		exporting = true;
		onbusy(true);
		try {
			const bundle = await client.exportDrBundle(passphrase);
			downloadText(
				`authrim-saml-local-signing-dr-bundle-${bundle.tenantId || settings.tenantId}.json`,
				JSON.stringify(bundle, null, 2),
				'application/json'
			);
			toast.success(t('sl.dr.exported'));
			clear();
		} catch (error) {
			report(error);
		} finally {
			exporting = false;
			onbusy(false);
		}
	}

	async function importBundle() {
		const file = files[0];
		if (!file || !ready) return;
		importing = true;
		onbusy(true);
		try {
			let bundle: unknown;
			try {
				bundle = JSON.parse(await file.text());
			} catch {
				throw new Error(t('sl.dr.import.notJson'));
			}
			onchanged(await client.importDrBundle(bundle, passphrase));
			toast.success(t('sl.dr.imported'));
			clear();
			files = [];
		} catch (error) {
			report(error);
		} finally {
			importing = false;
			confirming = false;
			onbusy(false);
		}
	}
</script>

<Card title={t('sl.dr.title')} description={t('sl.dr.desc')} tone="warning">
	{#snippet actions()}
		<Badge tone="danger">{t('sl.dr.sensitive')}</Badge>
	{/snippet}

	<Callout tone="warning">{t('sl.dr.warning')}</Callout>

	<div class="fields">
		<TextField
			label={t('sl.dr.passphrase')}
			type="password"
			autocomplete="new-password"
			bind:value={passphrase}
			info={t('sl.dr.passphrase.hint', { min: DR_BUNDLE_PASSPHRASE_MIN_LENGTH })}
			disabled={busy || (!canExport && !canImport)}
		/>
		<TextField
			label={t('sl.dr.passphrase.confirm')}
			type="password"
			autocomplete="new-password"
			bind:value={confirmation}
			error={showProblem ? problemText : ''}
			disabled={busy || (!canExport && !canImport)}
		/>
	</div>

	{#if canExport}
		<div class="actions">
			<Button
				variant="secondary"
				icon="arrowDown"
				disabled={!ready || busy}
				loading={exporting}
				onclick={exportBundle}>{t('sl.dr.export')}</Button
			>
		</div>
	{/if}

	{#if canImport}
		<section class="import" aria-label={t('sl.dr.import.title')}>
			<h3 class="import__title">{t('sl.dr.import.title')}</h3>
			<p class="import__desc">{t('sl.dr.import.desc')}</p>
			<FileDrop
				label={t('sl.dr.import.file')}
				accept=".json,application/json"
				maxBytes={2 * 1024 * 1024}
				bind:files
				disabled={busy}
			/>
			<div class="actions">
				<Button
					variant="danger"
					icon="upload"
					disabled={!ready || files.length === 0 || busy}
					loading={importing}
					onclick={() => (confirming = true)}>{t('sl.dr.import')}</Button
				>
			</div>
		</section>
	{/if}
</Card>

<ConfirmDialog
	open={confirming}
	title={t('sl.dr.import.confirm.title')}
	body={t('sl.dr.import.confirm.body')}
	confirmLabel={t('sl.dr.import')}
	tone="danger"
	busy={importing}
	onconfirm={importBundle}
	oncancel={() => (confirming = false)}
/>

<style>
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--space-field);
		margin-top: var(--space-related);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-related);
	}

	.import {
		margin-top: var(--space-section);
		padding-top: var(--space-related);
		border-top: 1px solid var(--border-subtle);
	}

	.import__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	.import__desc {
		margin: 4px 0 var(--space-related);
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
