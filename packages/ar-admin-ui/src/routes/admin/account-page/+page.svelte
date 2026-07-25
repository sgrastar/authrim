<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getLocale } from '$i18n/i18n-svelte';
	import { adminScreensAPI, type Screen, type ScreenField } from '$lib/api/admin-screens';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';

	type PlacementWidth = 'full' | 'half';
	type VisibilityCondition =
		| 'always'
		| 'hidden'
		| 'passkey_enabled'
		| 'totp_enabled'
		| 'external_idp_enabled'
		| 'consent_records_available'
		| 'multiple_sessions';
	type Placement = {
		id: string;
		screen_key: string;
		width: PlacementWidth;
		enabled: boolean;
		condition: VisibilityCondition;
	};
	type PageLocalization = { title?: string; description?: string };
	type AccountPageDefinition = {
		schema_version: 'authrim.account_page.v1';
		base_preset_id?: 'authrim-default';
		base_preset_version?: number;
		title?: string;
		description?: string;
		localizations?: Record<string, PageLocalization>;
		screens: Placement[];
	};
	type PublishedDefinition = AccountPageDefinition & {
		resolved_at: string;
		screen_snapshots: Record<string, Screen>;
	};
	type PageRecord = {
		id: string;
		name: string;
		base_preset_id: 'authrim-default';
		base_preset_version: number;
		draft: AccountPageDefinition;
		published?: PublishedDefinition;
		rollback?: PublishedDefinition;
		published_version: number;
		published_at: string;
		created_at: number;
		updated_at: number;
	};
	type PagesDocument = {
		schema_version: 'authrim.account_pages.v1';
		default_page_id: string | null;
		pages: PageRecord[];
	};

	const CATEGORY = 'login-ui';
	const DRAFT_KEY = 'login-ui.account_page_draft';
	const PUBLISHED_KEY = 'login-ui.account_page_published';
	const PAGES_KEY = 'login-ui.account_pages';
	const PAGE_LOCALES = [
		['en', 'English'],
		['ja', '日本語'],
		['zh-CN', '简体中文'],
		['zh-TW', '繁體中文'],
		['es', 'Español'],
		['pt', 'Português'],
		['fr', 'Français'],
		['de', 'Deutsch'],
		['ko', '한국어'],
		['ru', 'Русский'],
		['id', 'Bahasa Indonesia']
	] as const;
	const DEFAULT_PAGE: AccountPageDefinition = {
		schema_version: 'authrim.account_page.v1',
		base_preset_id: 'authrim-default',
		base_preset_version: 1,
		screens: [
			{
				id: 'overview',
				screen_key: 'account_overview',
				width: 'full',
				enabled: true,
				condition: 'always'
			},
			{
				id: 'profile',
				screen_key: 'account_profile',
				width: 'half',
				enabled: true,
				condition: 'always'
			},
			{
				id: 'devices',
				screen_key: 'account_devices',
				width: 'half',
				enabled: true,
				condition: 'always'
			},
			{
				id: 'sessions',
				screen_key: 'account_sessions',
				width: 'half',
				enabled: true,
				condition: 'always'
			},
			{
				id: 'passkeys',
				screen_key: 'account_passkeys',
				width: 'half',
				enabled: true,
				condition: 'passkey_enabled'
			},
			{
				id: 'totp',
				screen_key: 'account_totp',
				width: 'full',
				enabled: true,
				condition: 'totp_enabled'
			},
			{
				id: 'consents',
				screen_key: 'account_consents',
				width: 'full',
				enabled: true,
				condition: 'always'
			},
			{
				id: 'activity',
				screen_key: 'account_activity',
				width: 'full',
				enabled: true,
				condition: 'always'
			}
		]
	};

	let loading = $state(true);
	let saving = $state(false);
	let publishing = $state(false);
	let error = $state('');
	let message = $state('');
	let settings = $state<CategorySettings | null>(null);
	let screens = $state<Screen[]>([]);
	let draft = $state<AccountPageDefinition>(cloneDefinition(DEFAULT_PAGE));
	let publishedVersion = $state(0);
	let publishedAt = $state('');
	let pagesDocument = $state<PagesDocument>({
		schema_version: 'authrim.account_pages.v1',
		default_page_id: null,
		pages: []
	});
	let selectedPageId = $state('');
	let editorLocale = $state(getLocale());
	let previewViewport = $state<'desktop' | 'mobile'>('desktop');
	let draggedIndex = $state<number | null>(null);

	let accountScreens = $derived(screens.filter((screen) => screen.screen_kind === 'account'));
	let placedKeys = $derived(draft.screens.map((placement) => placement.screen_key));
	let availableScreens = $derived(
		accountScreens.filter(
			(screen) => !placedKeys.includes(screen.screen_key) && Boolean(screen.is_active)
		)
	);

	function t(ja: string, en: string): string {
		return getLocale() === 'ja' ? ja : en;
	}

	function cloneDefinition(value: AccountPageDefinition): AccountPageDefinition {
		return JSON.parse(JSON.stringify(value)) as AccountPageDefinition;
	}

	function normalizeDefinition(value: unknown): AccountPageDefinition {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return cloneDefinition(DEFAULT_PAGE);
		}
		const record = value as Record<string, unknown>;
		if (!Array.isArray(record.screens)) return cloneDefinition(DEFAULT_PAGE);
		const usedIds: string[] = [];
		const normalized: Placement[] = [];
		for (const [index, entry] of record.screens.slice(0, 32).entries()) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const item = entry as Record<string, unknown>;
			const screenKey = typeof item.screen_key === 'string' ? item.screen_key.trim() : '';
			if (!/^[a-z0-9_-]{1,96}$/u.test(screenKey)) continue;
			const preferredId =
				typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(item.id)
					? item.id
					: `${screenKey}-${index + 1}`;
			let id = preferredId;
			let suffix = 2;
			while (usedIds.includes(id)) {
				id = `${preferredId}-${suffix}`;
				suffix += 1;
			}
			usedIds.push(id);
			normalized.push({
				id,
				screen_key: screenKey,
				width: item.width === 'half' ? 'half' : 'full',
				enabled: item.enabled !== false,
				condition: [
					'hidden',
					'passkey_enabled',
					'totp_enabled',
					'external_idp_enabled',
					'consent_records_available',
					'multiple_sessions'
				].includes(String(item.condition))
					? (item.condition as VisibilityCondition)
					: 'always'
			});
		}
		return {
			schema_version: 'authrim.account_page.v1',
			base_preset_id: 'authrim-default',
			base_preset_version:
				typeof record.base_preset_version === 'number' ? record.base_preset_version : 1,
			...(typeof record.title === 'string' && record.title.trim()
				? { title: record.title.trim().slice(0, 120) }
				: {}),
			...(typeof record.description === 'string' && record.description.trim()
				? { description: record.description.trim().slice(0, 1000) }
				: {}),
			...(record.localizations && typeof record.localizations === 'object'
				? { localizations: record.localizations as Record<string, PageLocalization> }
				: {}),
			screens: normalized
		};
	}

	function parseDefinition(raw: unknown): AccountPageDefinition {
		if (typeof raw !== 'string' || !raw.trim()) return cloneDefinition(DEFAULT_PAGE);
		try {
			return normalizeDefinition(JSON.parse(raw));
		} catch {
			return cloneDefinition(DEFAULT_PAGE);
		}
	}

	function screenForPlacement(placement: Placement): Screen | undefined {
		return accountScreens.find((screen) => screen.screen_key === placement.screen_key);
	}

	function screenTitle(screen: Screen | undefined): string {
		if (!screen) return t('削除されたスクリーン', 'Missing screen');
		const localization = screen.localizations?.[editorLocale];
		return localization?.display_name || screen.display_name;
	}

	function localizedField(field: ScreenField, screen: Screen, index: number): ScreenField {
		const key = field.block_id ?? `${field.field}-${index}`;
		const localized = screen.localizations?.[editorLocale]?.fields?.[key];
		return { ...field, ...localized };
	}

	function widgetLabel(field: ScreenField): string {
		const labels: Partial<Record<NonNullable<ScreenField['block_type']>, string>> = {
			account_profile_widget: t('ユーザー情報', 'User profile'),
			account_device_list_widget: t('デバイス一覧', 'Device list'),
			account_session_widget: t('セッション管理', 'Session management'),
			account_passkey_widget: t('Passkey管理', 'Passkey management'),
			account_totp_widget: t('認証アプリ管理', 'Authenticator app management'),
			account_consent_widget: t('同意管理', 'Consent management'),
			account_activity_widget: t('操作履歴', 'Account activity'),
			account_social_account_widget: t('外部アカウント', 'Connected accounts')
		};
		return labels[field.block_type ?? 'identity_field'] ?? field.label;
	}

	function safePreviewHref(value: string | null | undefined): string {
		if (!value) return '#';
		if (/^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(value) || /^\/(?!\/)/u.test(value)) return value;
		try {
			const parsed = new URL(value);
			return parsed.protocol === 'https:' ? parsed.toString() : '#';
		} catch {
			return '#';
		}
	}

	function setTitle(value: string) {
		if (editorLocale === 'en') draft = { ...draft, title: value || undefined };
		else {
			draft = {
				...draft,
				localizations: {
					...draft.localizations,
					[editorLocale]: { ...draft.localizations?.[editorLocale], title: value || undefined }
				}
			};
		}
	}

	function setDescription(value: string) {
		if (editorLocale === 'en') draft = { ...draft, description: value || undefined };
		else {
			draft = {
				...draft,
				localizations: {
					...draft.localizations,
					[editorLocale]: {
						...draft.localizations?.[editorLocale],
						description: value || undefined
					}
				}
			};
		}
	}

	function addScreen(screen: Screen) {
		const base = screen.screen_key.replace(/[^a-zA-Z0-9_-]/gu, '-') || 'screen';
		let id = base;
		let suffix = 2;
		const ids = new Set(draft.screens.map((item) => item.id));
		while (ids.has(id)) {
			id = `${base}-${suffix}`;
			suffix += 1;
		}
		draft = {
			...draft,
			screens: [
				...draft.screens,
				{ id, screen_key: screen.screen_key, width: 'full', enabled: true, condition: 'always' }
			]
		};
	}

	function updatePlacement(index: number, patch: Partial<Placement>) {
		draft = {
			...draft,
			screens: draft.screens.map((placement, itemIndex) =>
				itemIndex === index ? { ...placement, ...patch } : placement
			)
		};
	}

	function removePlacement(index: number) {
		draft = { ...draft, screens: draft.screens.filter((_, itemIndex) => itemIndex !== index) };
	}

	function movePlacement(from: number, to: number) {
		if (from === to || from < 0 || from >= draft.screens.length) return;
		const next = [...draft.screens];
		const [placement] = next.splice(from, 1);
		next.splice(Math.max(0, Math.min(to, next.length)), 0, placement);
		draft = { ...draft, screens: next };
	}

	function resetPreset() {
		if (!confirm(t('標準プリセットに戻しますか？', 'Reset to the built-in preset?'))) return;
		draft = cloneDefinition(DEFAULT_PAGE);
		message = t(
			'標準プリセットを編集中です。保存または公開してください。',
			'The built-in preset is now in the editor. Save or publish it.'
		);
	}

	function parsePagesDocument(raw: unknown, legacy: AccountPageDefinition): PagesDocument {
		if (typeof raw === 'string' && raw.trim()) {
			try {
				const parsed = JSON.parse(raw) as PagesDocument;
				if (parsed.schema_version === 'authrim.account_pages.v1' && Array.isArray(parsed.pages)) {
					return parsed;
				}
			} catch {
				// Migrate the legacy single-page settings below.
			}
		}
		const now = Date.now();
		return {
			schema_version: 'authrim.account_pages.v1',
			default_page_id: 'default-custom',
			pages: [
				{
					id: 'default-custom',
					name: t('カスタムアカウントページ', 'Custom account page'),
					base_preset_id: 'authrim-default',
					base_preset_version: 1,
					draft: legacy,
					published_version: 0,
					published_at: '',
					created_at: now,
					updated_at: now
				}
			]
		};
	}

	function selectedRecord(document = pagesDocument): PageRecord | undefined {
		return document.pages.find((page) => page.id === selectedPageId);
	}

	function replaceSelected(patch: Partial<PageRecord>): PagesDocument {
		return {
			...pagesDocument,
			pages: pagesDocument.pages.map((page) =>
				page.id === selectedPageId ? { ...page, ...patch, updated_at: Date.now() } : page
			)
		};
	}

	function selectPage(id: string) {
		const page = pagesDocument.pages.find((item) => item.id === id);
		if (!page) return;
		selectedPageId = id;
		draft = normalizeDefinition(page.draft);
		publishedVersion = page.published_version;
		publishedAt = page.published_at;
	}

	function createPage() {
		const now = Date.now();
		const id = `account-page-${now.toString(36)}`;
		const page: PageRecord = {
			id,
			name: t('新しいアカウントページ', 'New account page'),
			base_preset_id: 'authrim-default',
			base_preset_version: 1,
			draft: cloneDefinition(DEFAULT_PAGE),
			published_version: 0,
			published_at: '',
			created_at: now,
			updated_at: now
		};
		pagesDocument = { ...pagesDocument, pages: [...pagesDocument.pages, page] };
		selectPage(id);
	}

	function renameSelectedPage(name: string) {
		pagesDocument = replaceSelected({
			name: name.slice(0, 80) || t('名称未設定', 'Untitled page')
		});
	}

	async function deleteSelectedPage() {
		const current = selectedRecord();
		if (!current || pagesDocument.pages.length <= 1 || pagesDocument.default_page_id === current.id)
			return;
		if (!confirm(t(`「${current.name}」を削除しますか？`, `Delete “${current.name}”?`))) return;
		const previousDocument = pagesDocument;
		const nextPages = pagesDocument.pages.filter((page) => page.id !== current.id);
		pagesDocument = { ...pagesDocument, pages: nextPages };
		try {
			const values: Record<string, unknown> = { [PAGES_KEY]: JSON.stringify(pagesDocument) };
			const rawThemes = settings?.values['login-ui.custom_themes'];
			if (typeof rawThemes === 'string' && rawThemes.trim()) {
				const themeDocument = JSON.parse(rawThemes) as {
					themes?: Array<Record<string, unknown>>;
					active?: unknown;
				};
				if (Array.isArray(themeDocument.themes)) {
					values['login-ui.custom_themes'] = JSON.stringify({
						...themeDocument,
						themes: themeDocument.themes.map((theme) =>
							theme.account_page_id === current.id ? { ...theme, account_page_id: null } : theme
						)
					});
				}
			}
			await persist(values);
			selectPage(nextPages[0].id);
			message = t('ページを削除しました。', 'Page deleted.');
		} catch (deleteError) {
			pagesDocument = previousDocument;
			error =
				deleteError instanceof Error
					? deleteError.message
					: t('ページの削除に失敗しました。', 'Failed to delete the page.');
		}
	}

	function validateForPublish(definition: AccountPageDefinition): Record<string, Screen> {
		const ids: string[] = [];
		const keys: string[] = [];
		const snapshots: Record<string, Screen> = {};
		for (const placement of definition.screens.filter((item) => item.enabled)) {
			if (ids.includes(placement.id))
				throw new Error(t('配置IDが重複しています。', 'Placement IDs must be unique.'));
			if (keys.includes(placement.screen_key))
				throw new Error(
					t('同じスクリーンを複数配置できません。', 'A screen can only be placed once.')
				);
			ids.push(placement.id);
			keys.push(placement.screen_key);
			const screen = accountScreens.find(
				(item) => item.screen_key === placement.screen_key && Boolean(item.is_active)
			);
			if (!screen)
				throw new Error(
					t(
						`スクリーン ${placement.screen_key} が無効または存在しません。`,
						`Screen ${placement.screen_key} is missing or inactive.`
					)
				);
			const widgetCount = screen.fields.filter((field) =>
				field.block_type?.startsWith('account_')
			).length;
			if (widgetCount > 1)
				throw new Error(
					t(
						`${screen.display_name} には主要Widgetが複数あります。`,
						`${screen.display_name} contains multiple primary widgets.`
					)
				);
			snapshots[placement.screen_key] = JSON.parse(JSON.stringify(screen)) as Screen;
		}
		const stableTargets = new Set(
			definition.screens
				.filter((placement) => placement.enabled && placement.condition === 'always')
				.map((placement) => placement.id)
		);
		for (const screen of Object.values(snapshots)) {
			for (const field of screen.fields) {
				if (
					field.block_type === 'link' &&
					field.href?.startsWith('#') &&
					!stableTargets.has(field.href.slice(1))
				) {
					throw new Error(
						t(
							`リンク先 ${field.href} は常に表示される配置IDではありません。`,
							`Link target ${field.href} is not an always-visible placement ID.`
						)
					);
				}
			}
		}
		return snapshots;
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const [settingsResult, screensResult] = await Promise.all([
				adminSettingsAPI.getSettings(CATEGORY),
				adminScreensAPI.list()
			]);
			settings = settingsResult;
			screens = screensResult.screens;
			const legacy = parseDefinition(
				settingsResult.values[DRAFT_KEY] || settingsResult.values[PUBLISHED_KEY]
			);
			pagesDocument = parsePagesDocument(settingsResult.values[PAGES_KEY], legacy);
			selectedPageId = pagesDocument.default_page_id ?? pagesDocument.pages[0]?.id ?? '';
			selectPage(selectedPageId);
		} catch (loadError) {
			error =
				loadError instanceof Error
					? loadError.message
					: t('読み込みに失敗しました。', 'Failed to load account page settings.');
		} finally {
			loading = false;
		}
	}

	async function persist(values: Record<string, unknown>) {
		if (!settings)
			throw new Error(t('設定を再読み込みしてください。', 'Reload the settings before saving.'));
		const result = await adminSettingsAPI.updateSettings(CATEGORY, {
			ifMatch: settings.version,
			set: values
		});
		if (Object.keys(result.rejected).length > 0) {
			throw new Error(Object.values(result.rejected).join(' '));
		}
		settings = { ...settings, version: result.version, values: { ...settings.values, ...values } };
	}

	async function saveDraft() {
		saving = true;
		error = '';
		message = '';
		try {
			const definition = normalizeDefinition(draft);
			pagesDocument = replaceSelected({ draft: definition });
			await persist({ [PAGES_KEY]: JSON.stringify(pagesDocument) });
			message = t('下書きを保存しました。', 'Draft saved.');
		} catch (saveError) {
			error =
				saveError instanceof Error
					? saveError.message
					: t('保存に失敗しました。', 'Failed to save draft.');
		} finally {
			saving = false;
		}
	}

	async function publish() {
		publishing = true;
		error = '';
		message = '';
		const previousDocument = pagesDocument;
		try {
			const definition = normalizeDefinition(draft);
			const snapshots = validateForPublish(definition);
			const nextVersion = publishedVersion + 1;
			const now = new Date().toISOString();
			const current = selectedRecord();
			if (!current) throw new Error(t('ページが選択されていません。', 'No page is selected.'));
			const published: PublishedDefinition = {
				...definition,
				resolved_at: now,
				screen_snapshots: snapshots
			};
			pagesDocument = replaceSelected({
				draft: definition,
				published,
				rollback: current.published,
				published_version: nextVersion,
				published_at: now
			});
			if (!pagesDocument.default_page_id)
				pagesDocument = { ...pagesDocument, default_page_id: selectedPageId };
			await persist({ [PAGES_KEY]: JSON.stringify(pagesDocument) });
			publishedVersion = nextVersion;
			publishedAt = now;
			message = t(
				`アカウントページ v${nextVersion} を公開しました。`,
				`Published account page v${nextVersion}.`
			);
		} catch (publishError) {
			pagesDocument = previousDocument;
			error =
				publishError instanceof Error
					? publishError.message
					: t('公開に失敗しました。', 'Failed to publish account page.');
		} finally {
			publishing = false;
		}
	}

	async function rollbackPublished() {
		const current = selectedRecord();
		if (
			!current?.rollback ||
			!confirm(t('直前の公開版へ戻しますか？', 'Roll back to the previous published version?'))
		)
			return;
		publishing = true;
		error = '';
		const previousDocument = pagesDocument;
		try {
			const now = new Date().toISOString();
			pagesDocument = replaceSelected({
				draft: normalizeDefinition(current.rollback),
				published: current.rollback,
				rollback: current.published,
				published_version: current.published_version + 1,
				published_at: now
			});
			await persist({ [PAGES_KEY]: JSON.stringify(pagesDocument) });
			selectPage(selectedPageId);
			message = t(
				'直前の公開版へロールバックしました。',
				'Rolled back to the previous published version.'
			);
		} catch (rollbackError) {
			pagesDocument = previousDocument;
			error =
				rollbackError instanceof Error
					? rollbackError.message
					: t('ロールバックに失敗しました。', 'Rollback failed.');
		} finally {
			publishing = false;
		}
	}

	async function setDefaultPage() {
		if (!selectedRecord()?.published) {
			error = t(
				'既定にする前にページを公開してください。',
				'Publish the page before making it the default.'
			);
			return;
		}
		const previousDocument = pagesDocument;
		try {
			pagesDocument = { ...pagesDocument, default_page_id: selectedPageId };
			await persist({ [PAGES_KEY]: JSON.stringify(pagesDocument) });
			message = t('テナントの既定ページに設定しました。', 'Set as the tenant default page.');
		} catch (setError) {
			pagesDocument = previousDocument;
			error =
				setError instanceof Error
					? setError.message
					: t('既定ページの設定に失敗しました。', 'Failed to set the default page.');
		}
	}

	onMount(() => void load());
</script>

<svelte:head>
	<title>{t('アカウントページ編集 - Authrim管理画面', 'Account page editor - Authrim Admin')}</title
	>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={t('アカウントページ', 'Account page')}
		description={t(
			'完成済みのアカウントスクリーンを配置し、Login UIテーマと連動するページを作成します。',
			'Compose complete account screens into a page that follows the active Login UI theme.'
		)}
	>
		{#snippet actions()}
			<select
				class="page-select"
				value={selectedPageId}
				onchange={(event) => selectPage(event.currentTarget.value)}
				disabled={loading}
			>
				{#each pagesDocument.pages as page (page.id)}<option value={page.id}
						>{page.name}{pagesDocument.default_page_id === page.id
							? t('（既定）', ' (default)')
							: ''}</option
					>{/each}
			</select>
			<button class="button secondary" type="button" onclick={createPage} disabled={loading}>
				<span class="i-ph-plus"></span>{t('ページを作成', 'Create page')}
			</button>
			<button
				class="button secondary"
				type="button"
				onclick={deleteSelectedPage}
				disabled={loading ||
					pagesDocument.pages.length <= 1 ||
					pagesDocument.default_page_id === selectedPageId}
			>
				<span class="i-ph-trash"></span>{t('ページを削除', 'Delete page')}
			</button>
			<button class="button secondary" type="button" onclick={() => goto('/admin/themes')}>
				<span class="i-ph-palette"></span>
				{t('テーマを編集', 'Edit theme')}
			</button>
			<button class="button secondary" type="button" onclick={resetPreset} disabled={loading}>
				<span class="i-ph-arrow-counter-clockwise"></span>
				{t('プリセットに戻す', 'Reset preset')}
			</button>
			<button
				class="button secondary"
				type="button"
				onclick={rollbackPublished}
				disabled={loading || publishing || !selectedRecord()?.rollback}
			>
				{t('ロールバック', 'Rollback')}
			</button>
			<button
				class="button secondary"
				type="button"
				onclick={saveDraft}
				disabled={loading || saving || publishing}
			>
				{saving ? t('保存中...', 'Saving...') : t('下書き保存', 'Save draft')}
			</button>
			<button
				class="button primary"
				type="button"
				onclick={publish}
				disabled={loading || saving || publishing}
			>
				{publishing ? t('公開中...', 'Publishing...') : t('公開', 'Publish')}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if message}<p class="notice success" role="status">{message}</p>{/if}

	<div class="publish-meta">
		<span>{t('公開バージョン', 'Published version')}: {publishedVersion || '-'}</span>
		<span
			>{t('公開日時', 'Published at')}: {publishedAt
				? new Date(publishedAt).toLocaleString()
				: '-'}</span
		>
		<span class="theme-link"
			><span class="i-ph-palette"></span>{t(
				'有効なLogin UIテーマを継承',
				'Inherits the active Login UI theme'
			)}</span
		>
		<button
			class="button secondary"
			type="button"
			onclick={setDefaultPage}
			disabled={pagesDocument.default_page_id === selectedPageId || !selectedRecord()?.published}
		>
			{t('既定ページに設定', 'Set as default')}
		</button>
	</div>

	{#if loading}
		<div class="loading-state">
			{t('アカウントページを読み込んでいます...', 'Loading account page...')}
		</div>
	{:else}
		<section class="page-copy">
			<label>
				<span>{t('ページ管理名', 'Page name')}</span>
				<input
					value={selectedRecord()?.name ?? ''}
					maxlength="80"
					oninput={(event) => renameSelectedPage(event.currentTarget.value)}
				/>
			</label>
			<label>
				<span>{t('編集ロケール', 'Editing locale')}</span>
				<select bind:value={editorLocale}>
					{#each PAGE_LOCALES as locale (locale[0])}<option value={locale[0]}
							>{locale[1]} ({locale[0]})</option
						>{/each}
				</select>
			</label>
			<label>
				<span>{t('ページタイトル（任意）', 'Page title (optional)')}</span>
				<input
					value={editorLocale === 'en'
						? (draft.title ?? '')
						: (draft.localizations?.[editorLocale]?.title ?? '')}
					placeholder={t('アカウント', 'Account')}
					oninput={(event) => setTitle(event.currentTarget.value)}
				/>
			</label>
			<label>
				<span>{t('ページ説明（任意）', 'Page description (optional)')}</span>
				<textarea
					rows="2"
					value={editorLocale === 'en'
						? (draft.description ?? '')
						: (draft.localizations?.[editorLocale]?.description ?? '')}
					oninput={(event) => setDescription(event.currentTarget.value)}
				></textarea>
			</label>
		</section>

		<div class="editor-grid">
			<aside class="panel screen-library">
				<div class="panel-heading">
					<div>
						<h2>{t('スクリーン', 'Screens')}</h2>
						<p>
							{t(
								'ページに追加できるAccountスクリーンです。',
								'Account screens available for this page.'
							)}
						</p>
					</div>
					<button
						class="icon-button"
						type="button"
						title={t('スクリーンを編集', 'Edit screens')}
						onclick={() => goto('/admin/screens')}
					>
						<span class="i-ph-pencil-simple"></span>
					</button>
				</div>
				{#if availableScreens.length === 0}
					<p class="empty">
						{t('追加できるスクリーンはありません。', 'All available screens are placed.')}
					</p>
				{:else}
					<div class="library-list">
						{#each availableScreens as screen (screen.id)}
							<button class="library-item" type="button" onclick={() => addScreen(screen)}>
								<span class="i-ph-plus-circle"></span>
								<div>
									<strong>{screenTitle(screen)}</strong><small>{screen.description ?? ''}</small>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</aside>

			<section class="panel composition">
				<div class="panel-heading">
					<div>
						<h2>{t('ページ構成', 'Page composition')}</h2>
						<p>{t('順番、幅、表示状態を設定します。', 'Set order, width, and visibility.')}</p>
					</div>
				</div>
				{#if draft.screens.length === 0}
					<div class="empty composition-empty">
						{t('左の一覧からスクリーンを追加してください。', 'Add a screen from the library.')}
					</div>
				{:else}
					<div class="placement-list">
						{#each draft.screens as placement, index (placement.id)}
							{@const screen = screenForPlacement(placement)}
							<article
								class="placement"
								class:disabled={!placement.enabled}
								draggable="true"
								ondragstart={() => (draggedIndex = index)}
								ondragover={(event) => event.preventDefault()}
								ondrop={() => {
									if (draggedIndex !== null) movePlacement(draggedIndex, index);
									draggedIndex = null;
								}}
								ondragend={() => (draggedIndex = null)}
							>
								<div class="placement-main">
									<span class="drag-handle i-ph-dots-six-vertical" aria-hidden="true"></span>
									<div class="placement-copy">
										<strong>{screenTitle(screen)}</strong><small>{placement.screen_key}</small>
									</div>
								</div>
								<div class="placement-controls">
									<label class="compact-control">
										<span>{t('表示条件', 'Condition')}</span>
										<select
											value={placement.condition}
											onchange={(event) =>
												updatePlacement(index, {
													condition: event.currentTarget.value as VisibilityCondition
												})}
										>
											<option value="always">{t('常に表示', 'Always')}</option>
											<option value="hidden">{t('非表示', 'Hidden')}</option>
											<option value="passkey_enabled">Passkey</option>
											<option value="totp_enabled">TOTP</option>
											<option value="external_idp_enabled">External IdP</option>
											<option value="consent_records_available"
												>{t('同意記録あり', 'Consent records')}</option
											>
											<option value="multiple_sessions"
												>{t('複数セッション', 'Multiple sessions')}</option
											>
										</select>
									</label>
									<label class="compact-control">
										<span>{t('幅', 'Width')}</span>
										<select
											value={placement.width}
											onchange={(event) =>
												updatePlacement(index, {
													width: event.currentTarget.value as PlacementWidth
												})}
										>
											<option value="full">{t('全幅', 'Full')}</option>
											<option value="half">{t('半幅', 'Half')}</option>
										</select>
									</label>
									<label class="toggle-control"
										><input
											type="checkbox"
											checked={placement.enabled}
											onchange={(event) =>
												updatePlacement(index, { enabled: event.currentTarget.checked })}
										/><span>{t('表示', 'Show')}</span></label
									>
									<div class="order-buttons">
										<button
											type="button"
											title={t('上へ', 'Move up')}
											disabled={index === 0}
											onclick={() => movePlacement(index, index - 1)}
											><span class="i-ph-arrow-up"></span></button
										>
										<button
											type="button"
											title={t('下へ', 'Move down')}
											disabled={index === draft.screens.length - 1}
											onclick={() => movePlacement(index, index + 1)}
											><span class="i-ph-arrow-down"></span></button
										>
										<button
											class="danger"
											type="button"
											title={t('外す', 'Remove')}
											onclick={() => removePlacement(index)}><span class="i-ph-x"></span></button
										>
									</div>
								</div>
							</article>
						{/each}
					</div>
				{/if}
			</section>

			<aside class="panel preview-panel">
				<div class="panel-heading">
					<div>
						<h2>{t('プレビュー', 'Preview')}</h2>
						<p>{t('モバイルでは1列になります。', 'Mobile collapses to one column.')}</p>
					</div>
				</div>
				<div class="preview-controls">
					<select bind:value={previewViewport}
						><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select
					>
				</div>
				<div class="account-preview" class:mobile={previewViewport === 'mobile'}>
					<header>
						<h3>
							{editorLocale === 'en'
								? draft.title || 'Account'
								: draft.localizations?.[editorLocale]?.title ||
									draft.title ||
									t('アカウント', 'Account')}
						</h3>
						{#if editorLocale === 'en' ? draft.description : draft.localizations?.[editorLocale]?.description || draft.description}
							<p>
								{editorLocale === 'en'
									? draft.description
									: draft.localizations?.[editorLocale]?.description || draft.description}
							</p>
						{/if}
					</header>
					<div class="preview-grid">
						{#each draft.screens.filter((item) => item.enabled && item.condition !== 'hidden') as placement (placement.id)}
							{@const screen = screenForPlacement(placement)}
							{#if screen}
								<section class:full={placement.width === 'full'} class="screen-preview-card">
									{#each [...screen.fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) as rawField, fieldIndex (`${rawField.block_id ?? rawField.field}:${fieldIndex}`)}
										{@const field = localizedField(rawField, screen, fieldIndex)}
										{#if field.block_type === 'heading'}<h4>{field.label}</h4>
											{#if field.text}<p>{field.text}</p>{/if}
										{:else if field.block_type === 'text'}<p>{field.text || field.label}</p>
										{:else if field.block_type === 'link'}<a href={safePreviewHref(field.href)}
												>{field.label}</a
											>
										{:else if field.block_type === 'divider'}<hr />
										{:else if field.block_type === 'layout_row'}{:else}<div class="widget-preview">
												<span class="i-ph-squares-four"></span><strong>{widgetLabel(field)}</strong>
											</div>
										{/if}
									{/each}
								</section>
							{/if}
						{/each}
					</div>
				</div>
			</aside>
		</div>
	{/if}
</AdminPageShell>

<style>
	:global(.admin-page__actions) {
		align-items: stretch;
	}
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-height: 2.5rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.55rem 0.85rem;
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}
	.button.primary {
		border-color: var(--color-primary);
		background: var(--color-primary);
		color: var(--button-primary-color, #fff);
	}
	.button.secondary {
		background: var(--color-surface);
		color: var(--color-text);
	}
	.button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
	.notice {
		margin: 0 0 1rem;
		border-radius: 8px;
		padding: 0.75rem 0.9rem;
	}
	.notice.error {
		border: 1px solid color-mix(in srgb, var(--color-error) 42%, transparent);
		background: color-mix(in srgb, var(--color-error) 10%, transparent);
		color: var(--color-error);
	}
	.notice.success {
		border: 1px solid color-mix(in srgb, var(--color-success) 42%, transparent);
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		color: var(--color-success);
	}
	.publish-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		margin-bottom: 1rem;
		color: var(--color-text-muted);
		font-size: 0.8rem;
	}
	.publish-meta span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.theme-link {
		color: var(--color-primary);
	}
	.loading-state,
	.empty {
		color: var(--color-text-muted);
		padding: 1rem 0;
	}
	.page-copy {
		display: grid;
		grid-template-columns: repeat(2, minmax(9rem, 0.55fr)) minmax(0, 0.8fr) minmax(0, 1.3fr);
		gap: 1rem;
		margin-bottom: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-surface);
		padding: 1rem;
	}
	label {
		display: grid;
		gap: 0.4rem;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		font-weight: 650;
	}
	input,
	textarea,
	select {
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: 7px;
		background: var(--color-surface);
		color: var(--color-text);
		padding: 0.55rem 0.65rem;
		font: inherit;
	}
	input:focus-visible,
	textarea:focus-visible,
	select:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
	.editor-grid {
		display: grid;
		grid-template-columns: minmax(190px, 0.72fr) minmax(360px, 1.35fr) minmax(280px, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.panel {
		min-width: 0;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-surface);
		padding: 1rem;
	}
	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.9rem;
	}
	.panel-heading h2 {
		margin: 0;
		font-size: 1rem;
	}
	.panel-heading p {
		margin: 0.25rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}
	.icon-button,
	.order-buttons button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
		cursor: pointer;
	}
	.library-list,
	.placement-list {
		display: grid;
		gap: 0.55rem;
	}
	.library-item {
		display: flex;
		width: 100%;
		align-items: flex-start;
		gap: 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text);
		padding: 0.7rem;
		text-align: left;
		cursor: pointer;
	}
	.library-item:hover {
		border-color: var(--color-primary);
		background: var(--color-surface-muted);
	}
	.library-item > span {
		margin-top: 0.1rem;
		color: var(--color-primary);
		font-size: 1.1rem;
	}
	.library-item div,
	.placement-copy {
		display: grid;
		min-width: 0;
		gap: 0.18rem;
	}
	.library-item small,
	.placement-copy small {
		overflow: hidden;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		text-overflow: ellipsis;
	}
	.placement {
		display: grid;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.75rem;
		transition:
			opacity 120ms ease,
			border-color 120ms ease;
	}
	.placement.disabled {
		opacity: 0.58;
	}
	.placement-main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}
	.drag-handle {
		color: var(--color-text-muted);
		cursor: grab;
		font-size: 1.2rem;
	}
	.placement-controls {
		display: grid;
		grid-template-columns: minmax(90px, 0.7fr) auto auto;
		gap: 0.65rem;
		align-items: end;
	}
	.compact-control select {
		min-height: 2rem;
		padding: 0.3rem 0.45rem;
	}
	.toggle-control {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 2rem;
	}
	.toggle-control input {
		width: auto;
	}
	.order-buttons {
		display: flex;
		gap: 0.3rem;
	}
	.order-buttons button:disabled {
		cursor: not-allowed;
		opacity: 0.35;
	}
	.order-buttons button.danger {
		color: var(--color-error);
	}
	.composition-empty {
		border: 1px dashed var(--color-border);
		border-radius: 8px;
		padding: 1rem;
		text-align: center;
	}
	.account-preview {
		border-radius: 9px;
		background: var(--color-surface-muted);
		padding: 0.85rem;
	}
	.preview-controls {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.65rem;
	}
	.preview-controls select {
		min-width: 0;
		padding: 0.35rem;
	}
	.account-preview.mobile {
		max-width: 22rem;
		margin-inline: auto;
	}
	.account-preview.mobile .preview-grid {
		grid-template-columns: 1fr;
	}
	.account-preview header {
		margin-bottom: 0.75rem;
	}
	.account-preview h3,
	.account-preview h4 {
		margin: 0;
	}
	.account-preview header p,
	.screen-preview-card p {
		margin: 0.3rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		line-height: 1.5;
	}
	.preview-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.55rem;
	}
	.screen-preview-card {
		min-width: 0;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		padding: 0.7rem;
	}
	.screen-preview-card.full {
		grid-column: 1 / -1;
	}
	.screen-preview-card hr {
		border: 0;
		border-top: 1px solid var(--color-border);
	}
	.widget-preview {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.18rem 0.45rem;
		align-items: center;
	}
	.widget-preview > span {
		color: var(--color-primary);
		font-size: 1.1rem;
	}
	@media (max-width: 1180px) {
		.editor-grid {
			grid-template-columns: minmax(190px, 0.65fr) minmax(360px, 1.35fr);
		}
		.preview-panel {
			grid-column: 1 / -1;
		}
	}
	@media (max-width: 760px) {
		.page-copy,
		.editor-grid {
			grid-template-columns: 1fr;
		}
		.preview-panel {
			grid-column: auto;
		}
		.placement-controls {
			grid-template-columns: 1fr;
		}
		.preview-grid {
			grid-template-columns: 1fr;
		}
		.screen-preview-card.full {
			grid-column: auto;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.placement {
			transition: none;
		}
	}
</style>
