<script lang="ts">
	import { untrack } from 'svelte';
	import {
		checkLiteLogoDataUri,
		LITE_LOGO_MAX_BYTES,
		LITE_LOGO_MAX_HEIGHT,
		LITE_LOGO_MAX_WIDTH
	} from '@authrim/ar-lib-core/utils/lite-logo';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		LiteChangeInProgressError,
		LiteUnsupportedError,
		type LiteIssue,
		type LiteMode,
		type LiteModeClient,
		type LiteModeStatus
	} from '#lib/api/login-ui-lite-mode.js';
	import { hasMessage, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import ImageUpload from '#lib/ui/patterns/ImageUpload.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import SettingRow from '#lib/ui/patterns/SettingRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Toggle from '#lib/ui/primitives/Toggle.svelte';
	import { useChangeMark } from '#lib/ui/save/save-scope.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';

	/**
	 * The lite Login UI: a server-rendered sign-in for very poor networks. The switch takes effect
	 * at once (a Toggle, confirmed first): it publishes the mode to the tenant's policy store, and
	 * switching on is refused while the lite Login UI cannot do everything the tenant uses — the
	 * reasons are listed, from the readiness the API reports. The lite logo (a small still PNG or
	 * WebP, kept as a data: URI in the settings) is part of the page's draft and is saved with it.
	 */
	interface Props {
		client: LiteModeClient;
		/** The admin may switch (edit on the Login UI and the authentication methods). */
		canSwitch: boolean;
		/** The lite logo as a data: URI, '' for none; part of the page's draft (`liteLogo`). */
		logo: string;
		logoEditable: boolean;
		/** After a switch: the settings now record the mode (the page may reload them). */
		onswitched?: (mode: LiteMode) => void;
	}

	let { client, canSwitch, logo = $bindable(), logoEditable, onswitched }: Props = $props();

	type Status = 'loading' | 'ready' | 'error' | 'unavailable';
	let status = $state<Status>('loading');
	let lite = $state<LiteModeStatus>();
	let switching = $state(false);
	let confirming = $state<LiteMode | null>(null);
	/** Issues from a refused switch, when the API found more than the readiness said. */
	let refusedIssues = $state<LiteIssue[]>([]);

	async function load(): Promise<void> {
		status = 'loading';
		try {
			lite = await client.get();
			status = 'ready';
		} catch (error) {
			status = error instanceof ApiError && error.status === 503 ? 'unavailable' : 'error';
		}
	}
	$effect(() => {
		void client;
		untrack(load);
	});

	// A switch under way (ours or another admin's) ends on its own: look again until it has.
	const POLL_MS = 5000;
	$effect(() => {
		if (status !== 'ready' || !lite?.change_in_progress) return;
		const timer = setTimeout(() => void load(), POLL_MS);
		return () => clearTimeout(timer);
	});

	const on = $derived(lite?.mode === 'always');
	const issues = $derived(
		refusedIssues.length > 0 ? refusedIssues : (lite?.readiness.issues ?? [])
	);
	const canTurnOn = $derived(canSwitch && (lite?.readiness.ready ?? false));
	const busy = $derived(switching || (lite?.change_in_progress ?? false));

	async function switchTo(mode: LiteMode): Promise<void> {
		confirming = null;
		switching = true;
		refusedIssues = [];
		try {
			const result = await client.set(mode);
			if (!result.recorded) toast.error(t('lu.lite.notRecorded'));
			else toast.success(t(mode === 'always' ? 'lu.lite.turnedOn' : 'lu.lite.turnedOff'));
			await load();
			onswitched?.(mode);
		} catch (error) {
			if (error instanceof LiteUnsupportedError) {
				refusedIssues = error.issues;
				toast.error(t('lu.lite.refused'));
				await load();
			} else if (error instanceof LiteChangeInProgressError) {
				toast.error(t('lu.lite.inProgress'));
				await load();
			} else {
				toast.error(
					error instanceof Error && error.message ? error.message : t('common.saveFailed')
				);
			}
		} finally {
			switching = false;
		}
	}

	function issueText(issue: LiteIssue): string {
		const key = `lu.lite.issue.${issue.code}`;
		const text = hasMessage(key) ? t(key as MessageKey) : issue.code;
		const ids = [issue.subject, issue.detail].filter(Boolean).join(' / ');
		return ids ? `${text} (${ids})` : text;
	}

	// The logo: the draft holds a data: URI; the upload control shows it and takes a new file,
	// which is turned into a data: URI and checked as the API checks it (type, bytes, pixels, a
	// still image) before it is kept. Only the latest choice counts: an earlier file still being
	// read is dropped when another is chosen or the logo is removed.
	const marks = useChangeMark();
	let choice = 0;
	const logoChanged = $derived(marks.changed('liteLogo', logo));
	let logoValue = $state<string | File | null>(null);
	let logoError = $state<string | null>(null);
	$effect(() => {
		const current = logo || null;
		untrack(() => {
			if (!(logoValue instanceof File)) logoValue = current;
		});
	});
	$effect(() => {
		const picked = logoValue;
		if (!(picked instanceof File)) return;
		untrack(() => void takeLogo(picked));
	});

	async function takeLogo(file: File): Promise<void> {
		const mine = ++choice;
		logoError = null;
		let dataUri: string;
		try {
			dataUri = await readAsDataUri(file);
		} catch {
			if (mine !== choice) return;
			logoError = t('lu.lite.logo.unreadable');
			logoValue = logo || null;
			return;
		}
		if (mine !== choice) return;
		const check = checkLiteLogoDataUri(dataUri);
		if (!check.ok) {
			logoError = t(`lu.lite.logo.refused.${check.reason}`, {
				w: LITE_LOGO_MAX_WIDTH,
				h: LITE_LOGO_MAX_HEIGHT
			});
			logoValue = logo || null;
			return;
		}
		logo = dataUri;
		logoValue = dataUri;
	}

	function removeLogo(): void {
		choice += 1;
		logo = '';
		logoError = null;
	}

	const readAsDataUri = (file: File) =>
		new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(new Error(t('lu.lite.logo.unreadable')));
			reader.readAsDataURL(file);
		});
</script>

<Card title={t('lu.lite')} description={t('lu.lite.desc')} flush>
	{#if status === 'loading'}
		<div class="lite__pad"><LoadingState label={t('common.loading')} /></div>
	{:else if status === 'unavailable' || status === 'error'}
		<div class="lite__pad">
			<Callout
				tone="warning"
				title={t(status === 'unavailable' ? 'lu.lite.unavailable' : 'load.error.title')}
			>
				{t(status === 'unavailable' ? 'lu.lite.unavailable.body' : 'load.error.body')}
				<div class="lite__retry"><Button size="sm" onclick={load}>{t('load.retry')}</Button></div>
			</Callout>
		</div>
	{:else if lite}
		<SettingRow title={t('lu.lite.switch')} description={t('lu.lite.switch.desc')}>
			{#snippet meta()}
				<Badge tone={on ? 'success' : 'neutral'}>{t(on ? 'lu.lite.on' : 'lu.lite.off')}</Badge>
				{#if lite?.change_in_progress}<Badge tone="warning">{t('lu.lite.changing')}</Badge>{/if}
			{/snippet}
			<!-- The switch shows the published mode only; a click asks first, and the mode changes
			     when the API has switched (the setter never writes the switch itself). -->
			<Toggle
				label={t('lu.lite.switch')}
				bind:checked={() => on, (next) => (confirming = next ? 'always' : 'off')}
				disabled={busy || !canSwitch || (!on && !canTurnOn)}
			/>
		</SettingRow>
		{#if !on && issues.length > 0}
			<div class="lite__pad">
				<Callout tone="info" title={t('lu.lite.issues.title')}>
					<p>{t('lu.lite.issues.body')}</p>
					<ul class="lite__issues">
						{#each issues as issue, i (i)}
							<li>{issueText(issue)}</li>
						{/each}
					</ul>
				</Callout>
			</div>
		{/if}
		<div class="lite__pad lite__logo">
			{#if logoEditable}
				<ImageUpload
					label={t('lu.lite.logo')}
					shape="wide"
					accept="image/png,image/webp"
					maxBytes={LITE_LOGO_MAX_BYTES}
					changed={logoChanged}
					bind:value={logoValue}
					onremove={removeLogo}
				/>
				<p class="lite__logo-hint">
					{t('lu.lite.logo.desc', { w: LITE_LOGO_MAX_WIDTH, h: LITE_LOGO_MAX_HEIGHT })}
				</p>
				{#if logoError}<Callout tone="danger" live>{logoError}</Callout>{/if}
			{:else}
				<p class="lite__logo-hint">
					{t('lu.lite.logo')}: {logo ? t('lu.lite.logo.set') : t('lu.lite.logo.none')}
				</p>
				{#if logo}<img class="lite__logo-img" src={logo} alt={t('lu.lite.logo')} />{/if}
			{/if}
		</div>
	{/if}
</Card>

<ConfirmDialog
	open={confirming !== null}
	title={t(confirming === 'always' ? 'lu.lite.confirmOn.title' : 'lu.lite.confirmOff.title')}
	body={t(confirming === 'always' ? 'lu.lite.confirmOn.body' : 'lu.lite.confirmOff.body')}
	confirmLabel={t(confirming === 'always' ? 'lu.lite.confirmOn.ok' : 'lu.lite.confirmOff.ok')}
	busy={switching}
	onconfirm={() => confirming && switchTo(confirming)}
	oncancel={() => (confirming = null)}
/>

<style>
	.lite__pad {
		padding: var(--space-related) var(--box-pad);
	}

	.lite__retry {
		margin-top: var(--space-related);
	}

	.lite__issues {
		margin: var(--space-related) 0 0;
		padding-inline-start: 1.25em;
		display: grid;
		gap: 4px;
	}

	.lite__logo {
		display: grid;
		gap: var(--space-related);
		border-top: 1px solid var(--border-subtle);
	}

	.lite__logo-hint {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
	}

	.lite__logo-img {
		max-width: 320px;
		max-height: 80px;
		object-fit: contain;
	}
</style>
