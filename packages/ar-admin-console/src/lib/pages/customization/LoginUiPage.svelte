<script lang="ts">
	import { untrack } from 'svelte';
	import type { LoginUILocale } from '@authrim/ar-lib-core/types/login-ui-languages';
	import { settingsLevel, type AccessLevel, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError, ConflictError, RejectedError } from '#lib/api/api-error.js';
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
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
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
	 * 4. whether the switch adds English names.
	 * Read from and saved to the `login-ui` settings of the tenant, with the version read, so
	 * another admin's save in between is noticed, not overwritten. A language setting the platform
	 * has fixed, or a page the admin may only look at, is shown as text.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const allowed = $derived<AccessLevel>(settingsLevel(who, 'login-ui', 'tenant'));
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
	 * What the API holds becomes "saved"; the admin's values of `keep` (settings that did not get
	 * there) go back on the screen, so nothing of theirs is lost and nothing of anyone else's is
	 * undone. Fails as the page does when the admin may no longer read the settings.
	 */
	async function refresh(screen: LanguageValues, keep: Iterable<string>): Promise<void> {
		if (!draft) return;
		try {
			loaded = await client.get(target, 'login-ui');
		} catch (error) {
			if (error instanceof ApiError && error.forbidden) status = 'forbidden';
			throw error;
		}
		draft.reset(valuesFrom(loaded.values));
		const fixedNow = new Set(loaded.locked);
		for (const key of keep) {
			const field = fieldOfKey(key);
			// A setting fixed meanwhile shows the fixed value, not the admin's.
			if (field && !fixedNow.has(key)) {
				draft.value = { ...draft.value, [field]: copyValue(screen[field]) };
			}
		}
	}

	async function save(screen: LanguageValues): Promise<void> {
		if (!draft || !loaded || level !== 'edit') return;
		const set = changesBetween(draft.saved, screen, fixedKeys);
		const changed = Object.keys(set);
		if (changed.length === 0) return;
		try {
			const result = await client.patch(target, 'login-ui', { ifMatch: loaded.version, set });
			const rejected = result.rejected ?? {};
			await refresh(screen, Object.keys(rejected));
			const reasons = Object.values(rejected);
			if (reasons.length > 0) throw new Error(t('settings.rejected', { reason: reasons[0] }));
		} catch (error) {
			if (error instanceof ConflictError) {
				// Their values become "saved"; only what the admin changed stays on the screen.
				await refresh(screen, changed);
				throw new Error(t('lu.conflict'));
			}
			if (error instanceof RejectedError) {
				const reason = Object.values(error.rejected)[0] ?? error.message;
				throw new Error(t('settings.rejected', { reason }));
			}
			if (error instanceof ApiError && error.forbidden) {
				refused = true;
				await refresh(screen, []);
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
{#snippet fixed(field: LanguageField, text: string)}
	<DetailList ruled>
		<DetailItem label={t(`lu.${field === 'defaultLang' ? 'default' : field}`)}>
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
