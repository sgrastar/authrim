<script lang="ts">
	import { untrack } from 'svelte';
	import type { CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
	import { settingsLevel, widest, type AccessLevel, type AdminAccess } from '$lib/access/access';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { ApiError, ConflictError, RejectedError } from '$lib/api/api-error';
	import {
		targetKey,
		type SettingsClient,
		type SettingsPatchResult,
		type SettingsTarget
	} from '$lib/api/settings';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import Disclosure from '$lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import OnOff from '$lib/ui/primitives/OnOff.svelte';
	import { copyValue, Draft } from '$lib/ui/save/draft.svelte';
	import { SaveStopped } from '$lib/ui/save/save-scope';
	import SaveScope from '$lib/ui/save/SaveScope.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import ConflictDialog, { type ConflictChoice } from './ConflictDialog.svelte';
	import { categoriesOf, categoryOf, type PlacedSetting, type SettingsPageDef } from './placement';
	import SettingField from './SettingField.svelte';
	import { formatSetting } from './setting-format';
	import { settingText } from './setting-text';
	import {
		changedBetween,
		changes,
		fallbackOf,
		fieldOf,
		metaOf,
		sectionView,
		valuesFrom,
		type Loaded,
		type Values
	} from './settings-model';

	/**
	 * A settings page built from a placement (`placement.ts`): the page's settings, taken from
	 * any Settings API categories, grouped in sections, each with what most admins need on view
	 * and the rest under Advanced. It handles, the same way on every settings page:
	 * - loading, a failed load (try again), and no access (the page says so, nothing else);
	 * - view-only access: values as text, with one note saying why;
	 * - which value applies (set here / the deployment's / Authrim's default) and going back;
	 * - saving per category with the version read, refused values shown on their field, and
	 *   someone else having saved first (ConflictDialog: the admin chooses).
	 */
	interface Props {
		page: SettingsPageDef;
		client: SettingsClient;
		target: SettingsTarget;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { page, client, target, access }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const categories = $derived(categoriesOf(page));
	const allowed = $derived(
		Object.fromEntries(
			categories.map((category) => [category, settingsLevel(who, category, target.level)])
		) as Record<CategoryName, AccessLevel>
	);

	/** Categories the API refused although the rules above allowed them (a custom role…). */
	let refused = $state<CategoryName[]>([]);
	const levels = $derived(
		Object.fromEntries(
			categories.map((category) => [
				category,
				refused.includes(category) ? 'none' : allowed[category]
			])
		) as Record<CategoryName, AccessLevel>
	);
	const pageLevel = $derived(widest(Object.values(levels)));

	type Status = 'loading' | 'ready' | 'error' | 'forbidden';
	let status = $state<Status>('loading');
	let loaded = $state<Loaded>({});
	let draft = $state<Draft<Values>>();
	/** Why the API refused a value, by setting key, from the last save. */
	let refusals = $state<Record<string, string>>({});
	let conflict = $state<{ changed: string[]; resolve: (choice: ConflictChoice) => void } | null>(
		null
	);

	async function fetchAll(): Promise<Loaded> {
		const readable = categories.filter((category) => allowed[category] !== 'none');
		const results = await Promise.allSettled(
			readable.map((category) => client.get(target, category))
		);
		const next: Loaded = {};
		const denied: CategoryName[] = [];
		results.forEach((result, i) => {
			if (result.status === 'fulfilled') next[readable[i]] = result.value;
			else if (result.reason instanceof ApiError && result.reason.forbidden)
				denied.push(readable[i]);
			else throw result.reason;
		});
		refused = denied;
		return next;
	}

	async function load(): Promise<void> {
		status = 'loading';
		refusals = {};
		if (widest(Object.values(allowed)) === 'none') {
			status = 'forbidden';
			return;
		}
		try {
			loaded = await fetchAll();
			if (Object.keys(loaded).length === 0) {
				status = 'forbidden';
				return;
			}
			draft = new Draft(valuesFrom(page, loaded));
			status = 'ready';
		} catch {
			status = 'error';
		}
	}

	// Load again when the scope (another tenant) or the admin's access changes.
	const loadKey = $derived(`${targetKey(target)}|${JSON.stringify(allowed)}`);
	$effect(() => {
		void loadKey;
		untrack(load);
	});

	function fieldsOf(request: { set?: Record<string, unknown>; clear?: string[] }): string[] {
		return [...Object.keys(request.set ?? {}), ...(request.clear ?? [])].map(fieldOf);
	}

	function only(values: Values, category: CategoryName): Values {
		return Object.fromEntries(
			Object.entries(values).filter(
				([field]) => categoryOf(field.replaceAll(':', '.')) === category
			)
		);
	}

	async function save(screen: Values): Promise<void> {
		if (!draft) return;
		refusals = {};
		const plan = changes(page, draft.saved, screen);
		/** Fields whose change did not reach the API; they stay unsaved on the screen. */
		const pending: string[] = [];
		const hold = (field: string) => {
			if (!pending.includes(field)) pending.push(field);
		};
		const refuse = (rejected: Readonly<Record<string, string>>) => {
			for (const [key, reason] of Object.entries(rejected)) {
				refusals[key] = reason;
				hold(fieldOf(key));
			}
		};
		const patch = (category: CategoryName, version: string): Promise<SettingsPatchResult> =>
			client.patch(target, category, { ifMatch: version, ...plan.get(category) });

		let stopped = false;
		let failure: unknown = null;
		for (const [category, request] of plan) {
			if (stopped || failure) {
				fieldsOf(request).forEach(hold);
				continue;
			}
			try {
				refuse((await patch(category, loaded[category]!.version)).rejected);
			} catch (error) {
				if (error instanceof RejectedError) {
					refuse(error.rejected);
				} else if (error instanceof ConflictError) {
					const latest = await client.get(target, category);
					const theirs = changedBetween(
						only(draft.saved, category),
						valuesFrom(page, { [category]: latest })
					);
					const choice = await new Promise<ConflictChoice>((resolve) => {
						conflict = { changed: theirs.map((key) => t(settingText(key).label)), resolve };
					});
					conflict = null;
					if (choice === 'overwrite') {
						try {
							refuse((await patch(category, latest.version)).rejected);
						} catch (again) {
							fieldsOf(request).forEach(hold);
							if (again instanceof RejectedError) refuse(again.rejected);
							else failure = again;
						}
					} else {
						// Reload: their values replace the admin's for this category (nothing pending).
						// Cancel: everything stays as it is on the screen.
						if (choice === 'cancel') fieldsOf(request).forEach(hold);
						stopped = true;
					}
				} else {
					fieldsOf(request).forEach(hold);
					failure = error;
				}
			}
		}

		// What the API holds now becomes "saved"; what did not get there stays on the screen.
		loaded = await fetchAll();
		const fresh = valuesFrom(page, loaded);
		draft.reset(fresh);
		for (const field of pending) {
			if (screen[field]) draft.value[field] = copyValue(screen[field]);
		}

		if (failure) throw failure;
		if (Object.keys(refusals).length > 0) throw new Error(t('settings.partial'));
		if (stopped || pending.length > 0) throw new SaveStopped();
	}
</script>

<Page>
	<PageHeader title={t(page.title)} description={t(page.description)} />

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
		{#if pageLevel === 'view'}
			<Callout icon="eye" title={t('settings.readOnly.title')}
				>{t('settings.readOnly.body')}</Callout
			>
		{/if}
		<SaveScope {draft} onsave={save}>
			<div class="settings">
				{#each page.sections as section (section.id)}
					{@const view = sectionView(section, draft!.value, levels, draft!.saved)}
					{#if view.primary.length + view.advanced.length > 0}
						<Card
							title={t(section.title)}
							description={section.description ? t(section.description) : undefined}
						>
							<div class="settings__fields">
								{@render rows(view.primary)}
								{#if view.advanced.length > 0}
									<div class="settings__more">
										<Disclosure
											boxed
											title={t('settings.advanced')}
											description={section.advanced ? t(section.advanced) : undefined}
										>
											{#snippet meta()}
												{#if view.setHere > 0}
													<Badge>{t('settings.setHere', { n: view.setHere })}</Badge>
												{/if}
											{/snippet}
											{@render rows(view.advanced)}
										</Disclosure>
									</div>
								{/if}
							</div>
						</Card>
					{/if}
				{/each}
			</div>
		</SaveScope>
		<ConflictDialog
			open={conflict !== null}
			changed={conflict?.changed ?? []}
			onchoose={(choice) => conflict?.resolve(choice)}
		/>
	{/if}
</Page>

<!-- A section's settings as table rows: a ruled list when the admin may only look, form rows
     (FieldRow, inside SettingField) when they may change them. -->
{#snippet rows(settings: PlacedSetting[])}
	{#if pageLevel === 'view'}
		<DetailList ruled>
			{#each settings as setting (setting.key)}
				{@render one(setting)}
			{/each}
		</DetailList>
	{:else}
		<div class="settings__rows">
			{#each settings as setting (setting.key)}
				{@render one(setting)}
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet one(setting: PlacedSetting)}
	{@const meta = metaOf(setting.key)!}
	{@const field = fieldOf(setting.key)}
	{#if levels[categoryOf(setting.key)] === 'edit'}
		<SettingField
			key={setting.key}
			{meta}
			bind:entry={draft!.value[field]}
			fallback={fallbackOf(setting.key, loaded)}
			level={target.level}
			decimal={setting.decimal}
			error={refusals[setting.key]
				? t('settings.rejected', { reason: refusals[setting.key] })
				: undefined}
		/>
	{:else if pageLevel === 'view'}
		{@render readItem(setting)}
	{:else}
		<!-- Mixed access on one page: a view-only setting among form rows. -->
		<DetailList ruled>{@render readItem(setting)}</DetailList>
	{/if}
{/snippet}

{#snippet readItem(setting: PlacedSetting)}
	{@const meta = metaOf(setting.key)!}
	{@const entry = draft!.value[fieldOf(setting.key)]}
	<DetailItem label={t(settingText(setting.key).label)}>
		{#if meta.type === 'boolean'}
			<OnOff on={entry.v === true} />
		{:else}
			{formatSetting(setting.key, meta, entry.v)}
		{/if}
		{#if meta.status === 'in_development'}
			<Badge>{t('settings.badge.inDevelopment')}</Badge>
		{:else if entry.locked}
			<Badge>{t('settings.badge.locked')}</Badge>
		{:else if entry.here}
			<Badge>{t('settings.badge.here')}</Badge>
		{/if}
	</DetailItem>
{/snippet}

<style>
	.settings {
		display: grid;
		gap: var(--space-section);
	}

	/* One name column for every row of a section, inside the Advanced box too: two fifths of
	   the section's width, less how far in the box starts (`--row-indent`, set by Disclosure). */
	.settings__fields {
		display: grid;
		container-type: inline-size;
		--row-name-col: calc((100cqi - var(--space-columns)) * 0.4);
	}

	.settings__fields :global(.disclosure__inner) {
		--row-name-col: calc((100cqi - var(--space-columns)) * 0.4 - var(--row-indent));
	}

	.settings__more {
		padding-top: var(--space-related);
	}
</style>
