<script lang="ts">
	import { untrack } from 'svelte';
	import { settingsLevel, widest, type AccessLevel, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError, ConflictError, RejectedError } from '#lib/api/api-error.js';
	import {
		targetKey,
		type SettingsClient,
		type SettingsPatchResult,
		type SettingsTarget
	} from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import { sectionNotices } from './setting-notices';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import OnOff from '#lib/ui/primitives/OnOff.svelte';
	import { copyValue, Draft } from '#lib/ui/save/draft.svelte.js';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import ConflictDialog, { type ConflictChoice } from './ConflictDialog.svelte';
	import {
		partIdOf,
		partOfKey,
		partsOf,
		type PlacedSetting,
		type SettingsPageDef,
		type SettingsPart,
		type SettingsSection
	} from './placement';
	import SettingField from './SettingField.svelte';
	import { formatSetting } from './setting-format';
	import { settingText } from './setting-text';
	import {
		changedBetween,
		changes,
		fallbackOf,
		fieldOf,
		keyOf,
		metaOf,
		readBadge,
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
	 * A `level: 'platform'` section is read and saved at the platform scope, whatever `target`
	 * is, and is left out for admins who may not see platform settings.
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
	const parts = $derived(partsOf(page));
	const partTarget = (part: SettingsPart): SettingsTarget =>
		part.platform ? { level: 'platform' } : target;
	const allowed = $derived(
		Object.fromEntries(
			parts.map((part) => [part.id, settingsLevel(who, part.category, partTarget(part).level)])
		) as Record<string, AccessLevel>
	);

	/** Parts the API refused although the rules above allowed them (a custom role…). */
	let refused = $state<string[]>([]);
	const levels = $derived(
		Object.fromEntries(
			parts.map((part) => [part.id, refused.includes(part.id) ? 'none' : allowed[part.id]])
		) as Record<string, AccessLevel>
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
		const readable = parts.filter((part) => allowed[part.id] !== 'none');
		const results = await Promise.allSettled(
			readable.map((part) => client.get(partTarget(part), part.category))
		);
		const next: Loaded = {};
		const denied: string[] = [];
		results.forEach((result, i) => {
			if (result.status === 'fulfilled') next[readable[i].id] = result.value;
			else if (result.reason instanceof ApiError && result.reason.forbidden)
				denied.push(readable[i].id);
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

	function only(values: Values, part: string): Values {
		return Object.fromEntries(
			Object.entries(values).filter(([field]) => partOfKey(page, keyOf(field)) === part)
		);
	}

	const partById = (id: string): SettingsPart => parts.find((part) => part.id === id)!;

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
		const patch = (id: string, version: string): Promise<SettingsPatchResult> => {
			const part = partById(id);
			return client.patch(partTarget(part), part.category, {
				ifMatch: version,
				...plan.get(id)
			});
		};

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
					const part = partById(category);
					const latest = await client.get(partTarget(part), part.category);
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
							{@const notices = sectionNotices(section, draft!.value)}
							{#if notices.length > 0}
								<div class="settings__notices">
									{#each notices as notice (notice.id)}
										<Callout tone={notice.tone} title={t(`settings.notice.${notice.id}.title`)}
											>{t(`settings.notice.${notice.id}.body`)}</Callout
										>
									{/each}
								</div>
							{/if}
							<div class="settings__fields">
								{@render rows(section, view.primary)}
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
											{@render rows(section, view.advanced)}
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
{#snippet rows(section: SettingsSection, settings: PlacedSetting[])}
	{#if pageLevel === 'view'}
		<DetailList ruled>
			{#each settings as setting (setting.key)}
				{@render one(section, setting)}
			{/each}
		</DetailList>
	{:else}
		<div class="settings__rows">
			{#each settings as setting (setting.key)}
				{@render one(section, setting)}
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet one(section: SettingsSection, setting: PlacedSetting)}
	{@const meta = metaOf(setting.key)!}
	{@const field = fieldOf(setting.key)}
	{@const part = partById(partIdOf(section, setting.key))}
	{#if levels[part.id] === 'edit'}
		<SettingField
			key={setting.key}
			{meta}
			bind:entry={draft!.value[field]}
			fallback={fallbackOf(setting.key, loaded, part.id)}
			level={partTarget(part).level}
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
		{@const badge = readBadge(meta, entry)}
		{#if badge}
			<Badge>{t(`settings.badge.${badge}`)}</Badge>
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

	.settings__notices {
		display: grid;
		gap: var(--space-related);
		margin-bottom: var(--space-section);
	}

	.settings__more {
		padding-top: var(--space-related);
	}
</style>
