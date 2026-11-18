<script lang="ts">
	import { untrack } from 'svelte';
	import type { LoginUILocale } from '@authrim/ar-lib-core/types/login-ui-languages';
	import { settingsLevel, type AccessLevel, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError, ConflictError, RejectedError } from '#lib/api/api-error.js';
	import type { LiteModeClient } from '#lib/api/login-ui-lite-mode.js';
	import type { SettingsClient, SettingsGetResult } from '#lib/api/settings.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ChoiceGrid, { type GridChoice } from '#lib/ui/patterns/ChoiceGrid.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import OnOff from '#lib/ui/primitives/OnOff.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { copyValue, Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import CustomBlocksEditor from './CustomBlocksEditor.svelte';
	import { BLOCKS_MAX } from './login-ui-custom-blocks';
	import LiteLoginUiCard from './LiteLoginUiCard.svelte';
	import {
		automaticFirst,
		changesBetween,
		fieldOfKey,
		FIRST_FROM,
		FIRST_MAX,
		KEYS,
		LOCALES,
		shownWithDefault,
		valuesFrom,
		type LanguageField,
		type LanguageValues
	} from './login-ui-languages';

	/**
	 * Customization → Login UI: the languages the sign-in screens offer. One question per step,
	 * each a control of its own (never three controls in one cell, as the previous Admin UI had):
	 * 1. which languages are shown (a choice grid; the default one stays on),
	 * 2. which is the default (a select limited to the languages shown),
	 * 3. which are listed first (a second grid limited to those shown, up to six, from eleven on),
	 * 4. whether the switch adds English names,
	 * the lite Login UI (LiteLoginUiCard): its switch, which takes effect at once through its own
	 * route, and its logo, saved with the languages; and the tenant's own content blocks around
	 * the screens (CustomBlocksEditor), saved with them too.
	 * Read from and saved to the `login-ui` settings of the tenant, with the version read, so
	 * another admin's save in between is noticed, not overwritten. A language setting the platform
	 * has fixed, or a page the admin may only look at, is shown as text.
	 */
	interface Props {
		client: SettingsClient;
		/** The lite Login UI switch; without it the lite section is not shown. */
		lite?: LiteModeClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, lite, tenantId, access }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const allowed = $derived<AccessLevel>(settingsLevel(who, 'login-ui', 'tenant'));
	// Switching the lite Login UI changes the human verification provider too: both edits.
	const canSwitchLite = $derived(
		allowed === 'edit' && settingsLevel(who, 'authentication-methods', 'tenant') === 'edit'
	);
	const target = $derived({ level: 'tenant', tenantId } as const);

	type Status = 'loading' | 'ready' | 'error' | 'forbidden';
	let status = $state<Status>('loading');
	let loaded = $state<SettingsGetResult>();
	let draft = $state<Draft<LanguageValues>>();
	/** The API refused the controls this page offered (a custom role). */
	let refused = $state(false);
	const level = $derived<AccessLevel>(refused ? 'view' : allowed);

	const locked = $derived(new Set(loaded?.locked ?? []));
	const editable = (field: LanguageField) => level === 'edit' && !locked.has(KEYS[field]);

	async function load(): Promise<void> {
		status = 'loading';
		if (allowed === 'none') {
			status = 'forbidden';
			return;
		}
		try {
			loaded = await client.get(target, 'login-ui');
			draft = new Draft(valuesFrom(loaded.values));
			status = 'ready';
		} catch (error) {
			status = error instanceof ApiError && error.forbidden ? 'forbidden' : 'error';
		}
	}

	// Load again when the scope (another tenant) or the admin's access changes.
	const loadKey = $derived(`${tenantId}|${allowed}`);
	$effect(() => {
		void loadKey;
		untrack(load);
	});

	/** The settings the admin may not change here: the platform's, or all of them (view only). */
	const fixedKeys = $derived(
		new Set(
			(Object.keys(KEYS) as LanguageField[])
				.filter((field) => !editable(field))
				.map((field) => KEYS[field])
		)
	);

	/**
	 * What the API holds becomes "saved"; the admin's unsaved edits, as they are when the answer
	 * comes (they may have gone on editing meanwhile), go back on the screen, so nothing of theirs
	 * is lost and nothing of anyone else's is undone. `drop` names settings whose edits are let
	 * go (the ones their save just applied are the same as the API's anyway). Fails as the page
	 * does when the admin may no longer read the settings.
	 */
	async function refresh(
		dropOf: (current: LanguageValues) => Iterable<string> = () => []
	): Promise<void> {
		if (!draft) return;
		try {
			loaded = await client.get(target, 'login-ui');
		} catch (error) {
			if (error instanceof ApiError && error.forbidden) status = 'forbidden';
			throw error;
		}
		const current = copyValue(draft.value);
		const dropped = new Set(dropOf(current));
		const edits = Object.keys(changesBetween(draft.saved, current)).filter(
			(key) => !dropped.has(key)
		);
		draft.reset(valuesFrom(loaded.values));
		const fixedNow = new Set(loaded.locked);
		for (const key of edits) {
			const field = fieldOfKey(key);
			// A setting fixed meanwhile shows the fixed value, not the admin's.
			if (field && !fixedNow.has(key)) {
				draft.value = { ...draft.value, [field]: copyValue(current[field]) };
			}
		}
		stale = false;
	}

	/**
	 * The settings changed under the page (the lite switch records its mode in the same category,
	 * with a new version): read them again, keeping the admin's unsaved changes. Until that has
	 * worked, the page's version is old, so saving waits (`stale`).
	 */
	let stale = $state(false);
	async function reloadKeepingEdits(): Promise<void> {
		try {
			await refresh();
		} catch {
			stale = true;
		}
	}

	async function save(screen: LanguageValues): Promise<void> {
		if (!draft || !loaded || level !== 'edit') return;
		if (stale) throw new Error(t('lu.stale.body'));
		const set = changesBetween(draft.saved, screen, fixedKeys);
		const changed = Object.keys(set);
		if (changed.length === 0) return;
		try {
			const result = await client.patch(target, 'login-ui', { ifMatch: loaded.version, set });
			const rejected = result.rejected ?? {};
			// What got there is the API's now (whatever anyone did to it since): its edits are let
			// go. What it refused, and anything typed meanwhile, stays as the admin has it.
			await refresh((current) => {
				const editedSince = new Set(Object.keys(changesBetween(screen, current)));
				return changed.filter((key) => !(key in rejected) && !editedSince.has(key));
			});
			const reasons = Object.values(rejected);
			if (reasons.length > 0) throw new Error(t('settings.rejected', { reason: reasons[0] }));
			// Edits made while saving are not saved: the bar stays up for them.
			if (draft.dirty) throw new SaveStopped();
		} catch (error) {
			if (error instanceof ConflictError) {
				// Their values become \"saved\"; what the admin changed stays on the screen.
				await refresh();
				throw new Error(t('lu.conflict'));
			}
			if (error instanceof RejectedError) {
				const reason = Object.values(error.rejected)[0] ?? error.message;
				throw new Error(t('settings.rejected', { reason }));
			}
			if (error instanceof ApiError && error.forbidden) {
				refused = true;
				await refresh(() => changed);
			}
			throw error;
		}
	}

	/** Name in the console's language, with the language's own name under it when it differs. */
	const names = $derived.by(() => {
		const inUi = new Intl.DisplayNames([i18n.locale], { type: 'language' });
		return (code: LoginUILocale) => {
			const own = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
			const label = inUi.of(code) ?? code;
			return { label, own: own === label ? undefined : own };
		};
	});
	const byName = (a: GridChoice, b: GridChoice) => a.label.localeCompare(b.label, i18n.locale);

	const shownOptions = $derived<GridChoice[]>(
		LOCALES.map((code) => {
			const { label, own } = names(code);
			const isDefault = code === draft?.value.defaultLang;
			return {
				value: code,
				label,
				detail: own,
				detailLang: code,
				locked: isDefault,
				note: isDefault ? t('lu.default.note') : undefined
			};
		}).sort(byName)
	);
	/** The languages shown, the default among them (the grid locks it on). */
	const effectiveShown = $derived<LoginUILocale[]>(draft ? shownWithDefault(draft.value) : []);
	const firstOptions = $derived(
		shownOptions.filter((option) => effectiveShown.includes(option.value as LoginUILocale))
	);
	const firstAvailable = $derived(effectiveShown.length >= FIRST_FROM);
	/** The languages listed first as the screens would list them now. */
	const firstShown = $derived<LoginUILocale[]>(
		draft ? (draft.value.first ?? automaticFirst(effectiveShown)) : []
	);

	// A language the admin stops showing cannot stay listed first (a fixed choice is left as is:
	// the screens drop it themselves, and it is never sent).
	$effect(() => {
		if (!draft || !editable('first')) return;
		const shown = effectiveShown;
		const { first } = draft.value;
		if (!first) return;
		const kept = first.filter((code) => shown.includes(code));
		if (kept.length !== first.length) draft.value.first = kept;
	});

	const listNames = (codes: readonly LoginUILocale[]) =>
		new Intl.ListFormat(i18n.locale, { type: 'unit' }).format(
			codes.map((code) => names(code).label)
		);
</script>

<Page>
	<PageHeader title={t('lu.page')} description={t('lu.page.desc')} />
	{#if status === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if status === 'forbidden'}
		<EmptyState icon="lock" title={t('access.none.title')} description={t('access.none.body')} />
	{:else if status === 'error'}
		<EmptyState icon="warning" title={t('load.error.title')} description={t('load.error.body')}>
			{#snippet action()}
				<Button onclick={load}>{t('load.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if draft}
		{#if level === 'view'}
			<Callout icon="eye" title={t('settings.readOnly.title')}
				>{t('settings.readOnly.body')}</Callout
			>
		{/if}
		{#if stale}
			<Callout tone="warning" title={t('lu.stale.title')} live>
				{t('lu.stale.body')}
				<div class="login-ui__retry">
					<Button size="sm" onclick={reloadKeepingEdits}>{t('load.retry')}</Button>
				</div>
			</Callout>
		{/if}
		<SaveScope {draft} onsave={save}>
			<div class="login-ui">
				<Card title={t('lu.shown')} description={t('lu.shown.desc')}>
					{#if editable('shown')}
						<ChoiceGrid
							label={t('lu.shown')}
							options={shownOptions}
							field="shown"
							bind:selected={() => effectiveShown, (next) => (draft!.value.shown = next)}
						/>
					{:else}
						{@render fixed('shown', listNames(effectiveShown))}
					{/if}
				</Card>

				<Card title={t('lu.default')} description={t('lu.default.desc')}>
					{#if editable('defaultLang')}
						<Select
							label={t('lu.default')}
							hideLabel
							inline
							field="defaultLang"
							value={draft.value.defaultLang}
							options={firstOptions.map((option) => ({
								value: option.value,
								label: option.label
							}))}
							onchange={(value) => (draft!.value.defaultLang = value as LoginUILocale)}
						/>
					{:else}
						{@render fixed('defaultLang', names(draft.value.defaultLang).label)}
					{/if}
				</Card>

				<Card title={t('lu.first')} description={t('lu.first.desc', { max: FIRST_MAX })}>
					{#if !firstAvailable}
						<Callout>{t('lu.first.needsMore', { n: FIRST_FROM })}</Callout>
					{:else if editable('first')}
						<div class="login-ui__first">
							<Checkbox
								field="first"
								changed={(draft.saved.first === null) !== (draft.value.first === null)}
								description={t('lu.first.auto.desc', {
									list: listNames(automaticFirst(effectiveShown))
								})}
								bind:checked={
									() => draft!.value.first === null,
									(auto) => (draft!.value.first = auto ? null : [...firstShown])
								}
							>
								{t('lu.first.auto')}
							</Checkbox>
							{#if draft.value.first !== null}
								<ChoiceGrid
									label={t('lu.first')}
									options={firstOptions.map(
										({ locked: _locked, note: _note, ...option }) => option
									)}
									max={FIRST_MAX}
									field="first"
									bind:selected={draft.value.first}
								/>
							{/if}
						</div>
					{:else}
						{@render fixed(
							'first',
							draft.value.first === null
								? t('lu.first.autoValue', { list: listNames(firstShown) })
								: listNames(firstShown)
						)}
					{/if}
				</Card>

				{#if lite}
					<LiteLoginUiCard
						client={lite}
						canSwitch={canSwitchLite && level === 'edit'}
						logoEditable={editable('liteLogo')}
						bind:logo={draft.value.liteLogo}
						onswitched={reloadKeepingEdits}
					/>
				{/if}

				<Card title={t('lu.blocks')} description={t('lu.blocks.desc', { max: BLOCKS_MAX })}>
					{#if editable('customBlocks')}
						<CustomBlocksEditor field="customBlocks" bind:blocks={draft.value.customBlocks} />
					{:else}
						{@render fixed(
							'customBlocks',
							draft.value.customBlocks.length === 0
								? t('lu.blocks.none')
								: t('lu.blocks.count', { n: draft.value.customBlocks.length })
						)}
					{/if}
				</Card>

				<Card title={t('lu.display')}>
					{#if editable('englishNames')}
						<Checkbox
							field="englishNames"
							description={t('lu.englishNames.desc')}
							bind:checked={draft.value.englishNames}
						>
							{t('lu.englishNames')}
						</Checkbox>
					{:else}
						<DetailList ruled>
							<DetailItem label={t('lu.englishNames')}>
								<OnOff on={draft.value.englishNames} />
								{#if locked.has(KEYS.englishNames)}
									<span class="login-ui__locked">{t('settings.locked.platform')}</span>
								{/if}
							</DetailItem>
						</DetailList>
					{/if}
				</Card>
			</div>
		</SaveScope>
	{/if}
</Page>

<!-- A setting shown as text: the admin may only look, or the platform has fixed it. -->
{#snippet fixed(field: Exclude<LanguageField, 'liteLogo'>, text: string)}
	<DetailList ruled>
		<DetailItem
			label={t(
				field === 'defaultLang'
					? 'lu.default'
					: field === 'customBlocks'
						? 'lu.blocks'
						: `lu.${field}`
			)}
		>
			{text}
			{#if locked.has(KEYS[field])}
				<span class="login-ui__locked">{t('settings.locked.platform')}</span>
			{/if}
		</DetailItem>
	</DetailList>
{/snippet}

<style>
	.login-ui {
		display: grid;
		gap: var(--space-section);
	}

	.login-ui__retry {
		margin-top: var(--space-related);
	}

	.login-ui__first {
		display: grid;
		gap: var(--space-related);
	}

	.login-ui__locked {
		margin-inline-start: var(--space-related);
		color: var(--text-secondary);
		font-size: var(--fs-label);
	}
</style>
