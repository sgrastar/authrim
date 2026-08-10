<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import {
		adminCustomClaimsAPI,
		type CustomClaimSchema,
		type FieldType
	} from '$lib/api/admin-custom-claims';
	import {
		SCREEN_LOCALIZATION_LANGUAGES,
		isDefaultScreenText,
		localizeDefaultScreenText,
		mergeLocalizedDefaultScreenText,
		type ScreenLocalizationLanguage
	} from '$lib/admin/screen-localizations';
	import { shouldShowAuthWidgetEmailInput } from '$lib/admin/screen-auth-widget-layout';
	import {
		findMissingRequiredRegistrationFields,
		normalizeRegistrationFieldKey,
		type RegistrationSchemaFieldOption
	} from '$lib/admin/screen-registration-requirements';
	import {
		adminScreensAPI,
		type Screen,
		type ScreenBlockType,
		type ScreenCanvasLayout,
		type ScreenDisplayCondition,
		type ScreenDisplayConditionFeature,
		type ScreenDisplayConditionMode,
		type ScreenField,
		type ScreenKind,
		type ScreenLocalization,
		type ScreenSettings,
		type ScreenValueType
	} from '$lib/api/admin-screens';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminTabs,
		type AdminTabItem
	} from '$lib/components/admin';

	type Draft = {
		id: string | null;
		screen_key: string;
		display_name: string;
		description: string;
		screen_kind: ScreenKind;
		fields: ScreenField[];
		localizations: Record<string, ScreenLocalization>;
		settings: ScreenSettings;
		is_active: boolean;
		is_system: boolean;
	};

	type ScreenPart = {
		type: ScreenBlockType;
		labelJa: string;
		labelEn: string;
		descriptionJa: string;
		descriptionEn: string;
		icon: string;
	};

	type AuthMethodOption = {
		value: string;
		label: string;
	};

	type ScreenEditorTab = 'items' | 'preview' | 'localization';
	type IdentitySchemaOption = RegistrationSchemaFieldOption & {
		source: 'system' | 'custom';
	};
	type LayoutSection = {
		id: string;
		columns: number;
		row?: { field: ScreenField; index: number };
		items: Array<{ field: ScreenField; index: number }>;
	};

	const kindOptions: ScreenKind[] = [
		'registration',
		'profile_completion',
		'login',
		'consent',
		'code_input',
		'account',
		'custom'
	];
	const screenParts: ScreenPart[] = [
		{
			type: 'layout_row',
			labelJa: 'レイアウト行',
			labelEn: 'Layout row',
			descriptionJa: '1カラム/2カラムの行を追加し、スクリーンの段組みを切り替えます。',
			descriptionEn: 'Add a one- or two-column row to control the screen layout.',
			icon: 'i-ph-columns'
		},
		{
			type: 'auth_widget',
			labelJa: '認証ウィジェット',
			labelEn: 'Auth widget',
			descriptionJa: '認証方式ごとに必要な入力欄と送信ボタンをまとめて配置します。',
			descriptionEn: 'Place one authentication method with its required inputs and action.',
			icon: 'i-ph-squares-four'
		},
		{
			type: 'code_input_widget',
			labelJa: 'コード入力',
			labelEn: 'Code input',
			descriptionJa: 'Mail OTPまたは認証アプリのコード入力スクリーンを配置します。',
			descriptionEn: 'Place a code entry screen for Mail OTP or authenticator app verification.',
			icon: 'i-ph-password'
		},
		{
			type: 'consent_widget',
			labelJa: '同意ウィジェット',
			labelEn: 'Consent widget',
			descriptionJa:
				'Flowで選択した同意ポリシーと、Destination Profileの必須・任意項目を表示します。',
			descriptionEn:
				'Render the Flow consent policy and required or optional Destination Profile fields.',
			icon: 'i-ph-handshake'
		},
		{
			type: 'heading',
			labelJa: '見出し',
			labelEn: 'Heading',
			descriptionJa: '画面内のタイトルや小見出しを配置します。',
			descriptionEn: 'Add a title or section heading.',
			icon: 'i-ph-text-h'
		},
		{
			type: 'identity_field',
			labelJa: 'Identity Schema項目',
			labelEn: 'Identity field',
			descriptionJa: 'メールアドレス、名前などのIdentity Schema項目を入力させます。',
			descriptionEn: 'Collect an Identity Schema field such as email or name.',
			icon: 'i-ph-textbox'
		},
		{
			type: 'text',
			labelJa: 'テキスト',
			labelEn: 'Text',
			descriptionJa: '説明文や補足を配置します。',
			descriptionEn: 'Add helper copy or static text.',
			icon: 'i-ph-text-align-left'
		},
		{
			type: 'link',
			labelJa: 'リンク',
			labelEn: 'Link',
			descriptionJa: '安全なページ内、相対、HTTPSリンクを配置します。',
			descriptionEn: 'Add a safe anchor, relative, or HTTPS link.',
			icon: 'i-ph-link-simple'
		},
		{
			type: 'security_verification',
			labelJa: 'セキュリティ確認',
			labelEn: 'Security check',
			descriptionJa: 'Captchaなどのセキュリティ確認枠を配置します。',
			descriptionEn: 'Place a security verification box such as CAPTCHA.',
			icon: 'i-ph-shield-check'
		},
		{
			type: 'divider',
			labelJa: '区切り線',
			labelEn: 'Divider',
			descriptionJa: 'スクリーン内の区切りを配置します。',
			descriptionEn: 'Add a visual divider.',
			icon: 'i-ph-line-segment'
		},
		{
			type: 'account_profile_widget',
			labelJa: 'ユーザー情報Widget',
			labelEn: 'User profile widget',
			descriptionJa: '表示、編集、保存、検証、成功・エラーをまとめて配置します。',
			descriptionEn: 'Profile display, editing, save, validation, success, and error states.',
			icon: 'i-ph-user-circle'
		},
		{
			type: 'account_device_list_widget',
			labelJa: 'デバイス一覧Widget',
			labelEn: 'Device list widget',
			descriptionJa: '登録デバイス、現在のデバイス、空・エラー状態を表示します。',
			descriptionEn: 'Devices, current-device state, empty state, and errors.',
			icon: 'i-ph-devices'
		},
		{
			type: 'account_session_widget',
			labelJa: 'セッション管理Widget',
			labelEn: 'Session management widget',
			descriptionJa: 'セッション一覧、個別ログアウト、確認・エラーをまとめます。',
			descriptionEn: 'Session list, revocation actions, confirmation, and errors.',
			icon: 'i-ph-monitor'
		},
		{
			type: 'account_passkey_widget',
			labelJa: 'Passkey管理Widget',
			labelEn: 'Passkey management widget',
			descriptionJa: 'Passkey一覧、登録、削除、再認証、各状態表示をまとめます。',
			descriptionEn: 'Passkey list, registration, removal, reauthentication, and states.',
			icon: 'i-ph-key'
		},
		{
			type: 'account_totp_widget',
			labelJa: '認証アプリWidget',
			labelEn: 'Authenticator app widget',
			descriptionJa: 'TOTP登録・削除、QRコード、バックアップコードをまとめます。',
			descriptionEn: 'TOTP enrollment, removal, QR setup, and backup codes.',
			icon: 'i-ph-device-mobile'
		},
		{
			type: 'account_consent_widget',
			labelJa: '同意管理Widget',
			labelEn: 'Consent management widget',
			descriptionJa: '同意一覧・詳細、取り下げ、確認・処理結果をまとめます。',
			descriptionEn: 'Consent list, details, withdrawal, confirmation, and results.',
			icon: 'i-ph-clipboard-text'
		},
		{
			type: 'account_activity_widget',
			labelJa: '操作履歴Widget',
			labelEn: 'Account activity widget',
			descriptionJa: 'アカウント操作の日時と内容、空・エラー状態を表示します。',
			descriptionEn: 'Account operation history with empty and error states.',
			icon: 'i-ph-clock-counter-clockwise'
		},
		{
			type: 'account_social_account_widget',
			labelJa: '外部アカウントWidget',
			labelEn: 'Connected account widget',
			descriptionJa: '外部アカウントの連携一覧と連携・解除状態を表示します。',
			descriptionEn: 'Connected external accounts and link or unlink states.',
			icon: 'i-ph-link'
		}
	];
	const accountWidgetTypes = new Set<ScreenBlockType>([
		'account_profile_widget',
		'account_device_list_widget',
		'account_session_widget',
		'account_passkey_widget',
		'account_totp_widget',
		'account_consent_widget',
		'account_activity_widget',
		'account_social_account_widget'
	]);
	const authMethodOptions: AuthMethodOption[] = [
		{ value: 'passkey', label: 'Passkey' },
		{ value: 'mail_otp', label: 'Mail OTP' },
		{ value: 'mail_otp_totp', label: 'Mail OTP＋認証アプリ' },
		{ value: 'totp', label: 'Authenticator app' },
		{ value: 'external_idp', label: 'Ext. IdP' },
		{ value: 'directory_password', label: 'Directory Password' }
	];
	const displayConditionModeOptions: Array<{
		value: ScreenDisplayConditionMode;
		labelJa: string;
		labelEn: string;
	}> = [
		{ value: 'always', labelJa: '常に表示', labelEn: 'Always show' },
		{
			value: 'feature_enabled',
			labelJa: '特定の要素が有効になっているとき表示',
			labelEn: 'Show when a feature is enabled'
		},
		{ value: 'hidden', labelJa: '非表示', labelEn: 'Hidden' }
	];
	const displayConditionFeatureOptions: Array<{
		value: ScreenDisplayConditionFeature;
		label: string;
	}> = authMethodOptions.map((option) => ({
		value: option.value as ScreenDisplayConditionFeature,
		label: option.label
	}));
	const codeInputModeOptions = [
		{ value: 'auto', labelJa: '自動', labelEn: 'Auto' },
		{ value: 'mail_otp', labelJa: 'Mail OTP', labelEn: 'Mail OTP' },
		{ value: 'totp', labelJa: '認証アプリ', labelEn: 'Authenticator app' }
	] as const;
	const humanVerificationTimingOptions = [
		{ value: 'initial', labelJa: '最初から表示', labelEn: 'Show initially' },
		{ value: 'submit', labelJa: '送信時に表示', labelEn: 'Show on submit' }
	] as const;
	const localizationLanguageLabels: Record<
		ScreenLocalizationLanguage,
		{ labelJa: string; labelEn: string }
	> = {
		en: { labelJa: '英語 (en)', labelEn: 'English (en)' },
		ja: { labelJa: '日本語 (ja)', labelEn: 'Japanese (ja)' },
		'zh-CN': { labelJa: '中国語 簡体字 (zh-CN)', labelEn: 'Chinese PRC (zh-CN)' },
		'zh-TW': { labelJa: '中国語 繁体字 (zh-TW)', labelEn: 'Chinese Taiwan (zh-TW)' },
		es: { labelJa: 'スペイン語 (es)', labelEn: 'Spanish (es)' },
		pt: { labelJa: 'ポルトガル語 (pt)', labelEn: 'Portuguese (pt)' },
		fr: { labelJa: 'フランス語 (fr)', labelEn: 'French (fr)' },
		de: { labelJa: 'ドイツ語 (de)', labelEn: 'German (de)' },
		ko: { labelJa: '韓国語 (ko)', labelEn: 'Korean (ko)' },
		ru: { labelJa: 'ロシア語 (ru)', labelEn: 'Russian (ru)' },
		id: { labelJa: 'インドネシア語 (id)', labelEn: 'Indonesian (id)' },
		ar: { labelJa: 'アラビア語 (ar)', labelEn: 'Arabic (ar)' },
		it: { labelJa: 'イタリア語 (it)', labelEn: 'Italian (it)' },
		th: { labelJa: 'タイ語 (th)', labelEn: 'Thai (th)' },
		vi: { labelJa: 'ベトナム語 (vi)', labelEn: 'Vietnamese (vi)' }
	};
	const localizationLanguages = SCREEN_LOCALIZATION_LANGUAGES.map((code) => ({
		code,
		...localizationLanguageLabels[code]
	}));
	const fallbackIdentitySchemaOptions: IdentitySchemaOption[] = [
		{
			field: 'email',
			label: 'Email',
			valueType: 'text',
			registrationRequired: false,
			source: 'system'
		},
		{
			field: 'name',
			label: 'Name',
			valueType: 'text',
			registrationRequired: false,
			source: 'system'
		},
		{
			field: 'given_name',
			label: 'Given name',
			valueType: 'text',
			registrationRequired: false,
			source: 'system'
		},
		{
			field: 'family_name',
			label: 'Family name',
			valueType: 'text',
			registrationRequired: false,
			source: 'system'
		},
		{
			field: 'preferred_username',
			label: 'Preferred username',
			valueType: 'text',
			registrationRequired: false,
			source: 'system'
		}
	];

	let screens = $state<Screen[]>([]);
	let identitySchemaOptions = $state<IdentitySchemaOption[]>(fallbackIdentitySchemaOptions);
	let selectedId = $state<string | null>(null);
	let viewMode = $state<'preview' | 'edit'>('preview');
	let editorTab = $state<ScreenEditorTab>('items');
	let draft = $state<Draft>(createEmptyDraft());
	let selectedBlockIndex = $state(0);
	let draggedPartType = $state<ScreenBlockType | null>(null);
	let draggedBlockIndex = $state<number | null>(null);
	let dropTargetIndex = $state<number | null>(null);
	let dropTargetColumn = $state<number | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let message = $state('');
	let screenPreviewViewport = $state<'desktop' | 'mobile'>('desktop');

	const selectedScreen = $derived(screens.find((screen) => screen.id === selectedId) ?? null);
	const previewFields = $derived(
		selectedScreen
			? [...selectedScreen.fields].sort(
					(a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
				)
			: []
	);
	const orderedDraftBlocks = $derived(
		[...draft.fields].sort(
			(a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
		)
	);
	const missingRequiredRegistrationFields = $derived(
		findMissingRequiredRegistrationFields(
			draft.screen_kind,
			orderedDraftBlocks,
			identitySchemaOptions
		)
	);
	const selectedBlock = $derived(orderedDraftBlocks[selectedBlockIndex] ?? null);
	const selectedBlockLayoutColumns = $derived(layoutColumnsForBlockIndex(selectedBlockIndex));
	const localizableDraftBlocks = $derived(
		orderedDraftBlocks.filter((field) => getBlockType(field) !== 'layout_row')
	);
	const previewLayoutSections = $derived(buildLayoutSections(previewFields));
	const draftLayoutSections = $derived(buildLayoutSections(orderedDraftBlocks));
	const editorTabItems = $derived<AdminTabItem[]>([
		{
			id: 'items',
			label: t('項目編集', 'Items'),
			icon: 'i-ph-list-bullets',
			panelId: 'screen-editor-items'
		},
		{
			id: 'preview',
			label: t('プレビュー', 'Preview'),
			icon: 'i-ph-eye',
			panelId: 'screen-editor-preview'
		},
		{
			id: 'localization',
			label: t('ローカライゼーション', 'Localization'),
			icon: 'i-ph-translate',
			panelId: 'screen-editor-localization'
		}
	]);

	onMount(() => {
		void loadScreens();
		void loadIdentitySchemaOptions();
	});

	function createEmptyDraft(): Draft {
		return {
			id: null,
			screen_key: '',
			display_name: '',
			description: '',
			screen_kind: 'registration',
			fields: [
				createBlock('heading', 0, {
					field: 'heading.registration',
					label: t('アカウントを作成', 'Create your account')
				}),
				createBlock('auth_widget', 10, {
					field: 'auth.passkey',
					label: t('Passkeyでアカウント作成', 'Create Account with Passkey'),
					auth_method: 'passkey'
				}),
				createBlock('identity_field', 15, {
					field: 'email',
					label: t('メールアドレス', 'Email'),
					required: false
				}),
				createBlock('divider', 20, {
					field: 'divider.or',
					label: t('または', 'or'),
					text: t('または', 'or'),
					display_condition: { mode: 'feature_enabled', feature: 'mail_otp' }
				}),
				createBlock('auth_widget', 30, {
					field: 'auth.mail_otp',
					label: t('認証コードをメール送信', 'Send code by email'),
					auth_method: 'mail_otp'
				}),
				createBlock('auth_widget', 35, {
					field: 'auth.totp',
					label: t('認証アプリで新規登録', 'Create account with authenticator app'),
					auth_method: 'totp'
				}),
				createBlock('divider', 40, {
					field: 'divider.other_accounts',
					label: t('他のアカウントで続行', 'Continue with another account'),
					text: t('他のアカウントで続行', 'Continue with another account'),
					display_condition: { mode: 'feature_enabled', feature: 'external_idp' }
				}),
				createBlock('auth_widget', 50, {
					field: 'auth.external_idp',
					label: 'Ext. IdP',
					auth_method: 'external_idp',
					external_idp_show_action_text: false
				}),
				createBlock('divider', 55, {
					field: 'divider.directory_password',
					label: t('または', 'or'),
					text: t('または', 'or'),
					display_condition: { mode: 'feature_enabled', feature: 'directory_password' }
				}),
				createBlock('auth_widget', 60, {
					field: 'auth.directory_password',
					label: t('ディレクトリパスワードでサインイン', 'Sign in with directory password'),
					auth_method: 'directory_password'
				})
			],
			localizations: {},
			settings: { canvas_layout: 'narrow' },
			is_active: true,
			is_system: false
		};
	}

	function t(ja: string, en: string): string {
		return getLocale() === 'ja' ? ja : en;
	}

	function createBlockId(type: ScreenBlockType): string {
		return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function normalizeInternalId(value: string): string {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 96);
		return normalized || `block-${Math.random().toString(36).slice(2, 8)}`;
	}

	function createStableBlockId(field: ScreenField, index: number): string {
		return normalizeInternalId(`${getBlockType(field)}-${field.field || 'block'}-${index + 1}`);
	}

	function getBlockType(block: ScreenField): ScreenBlockType {
		return block.block_type ?? 'identity_field';
	}

	function isAccountWidgetType(type: ScreenBlockType): boolean {
		return accountWidgetTypes.has(type);
	}

	function accountWidgetPart(type: ScreenBlockType): ScreenPart | undefined {
		return screenParts.find((part) => part.type === type);
	}

	function screenPartAvailable(part: ScreenPart): boolean {
		if (draft.screen_kind === 'account') {
			if (isAccountWidgetType(part.type)) {
				return !draft.fields.some((field) => isAccountWidgetType(getBlockType(field)));
			}
			return (
				part.type === 'layout_row' ||
				part.type === 'heading' ||
				part.type === 'text' ||
				part.type === 'divider' ||
				part.type === 'link'
			);
		}
		return !isAccountWidgetType(part.type);
	}

	function normalizeValueType(value: unknown): ScreenValueType {
		return value === 'boolean' ? 'boolean' : 'text';
	}

	function normalizeCanvasLayout(value: unknown): ScreenCanvasLayout {
		return value === 'wide' ? 'wide' : 'narrow';
	}

	function normalizeSettings(settings: ScreenSettings | null | undefined): ScreenSettings {
		return {
			canvas_layout: normalizeCanvasLayout(settings?.canvas_layout),
			...(settings?.base_preset_key ? { base_preset_key: settings.base_preset_key } : {}),
			...(settings?.base_preset_version
				? { base_preset_version: settings.base_preset_version }
				: {})
		};
	}

	function safePreviewHref(value: string | null | undefined): string {
		if (!value) return '#';
		if (/^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(value) || /^\/(?!\/)/u.test(value)) {
			return value;
		}
		try {
			const parsed = new URL(value);
			return parsed.protocol === 'https:' ? parsed.toString() : '#';
		} catch {
			return '#';
		}
	}

	function normalizeAuthMethod(value: unknown): string {
		if (typeof value === 'string' && authMethodOption(value)) return value;
		return 'passkey';
	}

	function normalizeHumanVerificationTiming(value: unknown): 'initial' | 'submit' {
		return value === 'submit' ? 'submit' : 'initial';
	}

	function humanVerificationTimingLabel(value: unknown): string {
		const timing = normalizeHumanVerificationTiming(value);
		const option = humanVerificationTimingOptions.find((item) => item.value === timing);
		return option ? t(option.labelJa, option.labelEn) : t('最初から表示', 'Show initially');
	}

	function authMethodOption(value: string): AuthMethodOption | null {
		return authMethodOptions.find((option) => option.value === value) ?? null;
	}

	function supportsDisplayCondition(type: ScreenBlockType): boolean {
		return (
			type === 'divider' ||
			type === 'heading' ||
			type === 'text' ||
			type === 'layout_row' ||
			type === 'identity_field'
		);
	}

	function normalizeDisplayConditionMode(value: unknown): ScreenDisplayConditionMode {
		return value === 'feature_enabled' || value === 'hidden' ? value : 'always';
	}

	function normalizeDisplayConditionFeature(value: unknown): ScreenDisplayConditionFeature {
		return typeof value === 'string' &&
			displayConditionFeatureOptions.some((option) => option.value === value)
			? (value as ScreenDisplayConditionFeature)
			: 'passkey';
	}

	function normalizeDisplayCondition(value: unknown): ScreenDisplayCondition | null {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		const mode = normalizeDisplayConditionMode(record.mode);
		if (mode === 'hidden') return { mode: 'hidden' };
		if (mode === 'feature_enabled') {
			return { mode: 'feature_enabled', feature: normalizeDisplayConditionFeature(record.feature) };
		}
		return null;
	}

	function displayConditionMode(block: ScreenField | null): ScreenDisplayConditionMode {
		return normalizeDisplayConditionMode(block?.display_condition?.mode);
	}

	function displayConditionFeature(block: ScreenField | null): ScreenDisplayConditionFeature {
		return normalizeDisplayConditionFeature(block?.display_condition?.feature);
	}

	function displayConditionLabel(block: ScreenField): string {
		const condition = normalizeDisplayCondition(block.display_condition);
		if (!condition || condition.mode === 'always') return '';
		if (condition.mode === 'hidden') return t('非表示', 'Hidden');
		const option = displayConditionFeatureOptions.find((item) => item.value === condition.feature);
		return t('表示条件: ', 'Condition: ') + (option?.label ?? condition.feature ?? 'Passkey');
	}

	function updateDisplayConditionMode(mode: ScreenDisplayConditionMode) {
		const nextMode = normalizeDisplayConditionMode(mode);
		if (nextMode === 'always') {
			updateField(selectedBlockIndex, { display_condition: null });
			return;
		}
		if (nextMode === 'hidden') {
			updateField(selectedBlockIndex, { display_condition: { mode: 'hidden' } });
			return;
		}
		updateField(selectedBlockIndex, {
			display_condition: {
				mode: 'feature_enabled',
				feature: displayConditionFeature(selectedBlock)
			}
		});
	}

	function updateDisplayConditionFeature(feature: ScreenDisplayConditionFeature) {
		updateField(selectedBlockIndex, {
			display_condition: {
				mode: 'feature_enabled',
				feature: normalizeDisplayConditionFeature(feature)
			}
		});
	}

	function selectedAuthWidgetMethod(block: ScreenField | null): string {
		if (!block) return 'passkey';
		return normalizeAuthMethod(block.auth_method);
	}

	function normalizeCodeInputMode(value: unknown): 'auto' | 'mail_otp' | 'totp' {
		return value === 'mail_otp' || value === 'totp' ? value : 'auto';
	}

	function selectedCodeInputMode(block: ScreenField | null): 'auto' | 'mail_otp' | 'totp' {
		if (!block) return 'auto';
		return normalizeCodeInputMode(block.code_input_mode ?? block.auth_method);
	}

	function updateAuthWidgetMethod(method: string) {
		if (!method || !authMethodOption(method)) return;
		updateField(selectedBlockIndex, {
			auth_method: method,
			field: `auth.${method}`,
			label: authWidgetDefaultLabel(method),
			external_idp_show_action_text:
				method === 'external_idp' ? false : selectedBlock?.external_idp_show_action_text
		});
	}

	function authWidgetDefaultLabel(method: string): string {
		switch (method) {
			case 'mail_otp':
				return t('認証コードをメール送信', 'Send code by email');
			case 'mail_otp_totp':
				return t('Mail OTP＋認証アプリ', 'Mail OTP + authenticator app');
			case 'totp':
				return t('認証アプリでログイン', 'Sign in with authenticator app');
			case 'external_idp':
				return 'Ext. IdP';
			case 'directory_password':
				return t('ログイン', 'Sign in');
			case 'passkey':
			default:
				return t('Passkeyでサインイン', 'Sign in with Passkey');
		}
	}

	function authWidgetDisplayLabel(field: ScreenField, method: string): string {
		const label = field.label;
		const defaultLabels = new Set([
			'Send verification code',
			'認証コードを送信',
			'Continue with authenticator app',
			'認証アプリで続行',
			'Sign up with verification code',
			'認証コードで登録',
			'Create account with authenticator app',
			'認証アプリでアカウント作成'
		]);
		if (!label || defaultLabels.has(label)) return authWidgetDefaultLabel(method);
		return label;
	}

	function externalIdpBaseLabel(label: string): string {
		const trimmed = label.trim();
		for (const suffix of ['でログイン', 'で続行']) {
			if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length).trim();
		}
		for (const prefix of ['Continue with ', 'Sign in with ', 'Login with ']) {
			if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
		}
		return trimmed || 'Ext. IdP';
	}

	function externalIdpPreviewLabel(field: ScreenField): string {
		const baseLabel = externalIdpBaseLabel(authWidgetDisplayLabel(field, 'external_idp'));
		return field.external_idp_show_action_text === true
			? $LL.login_continueWith({ provider: baseLabel })
			: baseLabel;
	}

	function codeInputDefaultLabel(mode: string): string {
		if (mode === 'totp') return t('認証アプリのコード', 'Authenticator app code');
		if (mode === 'mail_otp') return t('メール認証コード', 'Email verification code');
		return t('認証コード', 'Authentication code');
	}

	function valueTypeFromSchemaFieldType(fieldType: FieldType): ScreenValueType {
		return fieldType === 'boolean' ? 'boolean' : 'text';
	}

	function selectedSchemaOption(field: string | undefined): IdentitySchemaOption | null {
		if (!field) return null;
		const normalizedField = normalizeRegistrationFieldKey(field);
		return (
			identitySchemaOptions.find(
				(option) => normalizeRegistrationFieldKey(option.field) === normalizedField
			) ?? null
		);
	}

	function schemaControlsRegistrationRequirement(field: string | undefined): boolean {
		return draft.screen_kind === 'registration' && Boolean(selectedSchemaOption(field)?.schemaId);
	}

	function synchronizeDraftRegistrationRequirements() {
		if (draft.screen_kind !== 'registration') return;
		draft = {
			...draft,
			fields: draft.fields.map((field) => {
				if (getBlockType(field) !== 'identity_field') return field;
				const option = selectedSchemaOption(field.field);
				if (!option?.schemaId) return field;
				return { ...field, required: option.registrationRequired };
			})
		};
	}

	function normalizeIdentitySchemaOptions(schemas: CustomClaimSchema[]): IdentitySchemaOption[] {
		const options = new SvelteMap<string, IdentitySchemaOption>();
		for (const option of fallbackIdentitySchemaOptions) {
			options.set(normalizeRegistrationFieldKey(option.field), option);
		}
		for (const schema of schemas) {
			if (schema.is_active !== 1) continue;
			options.set(normalizeRegistrationFieldKey(schema.field_key), {
				field: schema.field_key,
				label: schema.display_label || schema.field_key,
				valueType: valueTypeFromSchemaFieldType(schema.field_type),
				registrationRequired: schema.registration_required === 1,
				schemaId: schema.id,
				source: schema.is_system === 1 ? 'system' : 'custom'
			});
		}
		return [...options.values()].sort((a, b) => {
			if (a.source !== b.source) return a.source === 'system' ? -1 : 1;
			return a.label.localeCompare(b.label);
		});
	}

	async function loadIdentitySchemaOptions() {
		try {
			const response = await adminCustomClaimsAPI.listSchemas({ limit: 500, is_active: '1' });
			identitySchemaOptions = normalizeIdentitySchemaOptions(response.schemas);
			synchronizeDraftRegistrationRequirements();
		} catch {
			identitySchemaOptions = fallbackIdentitySchemaOptions;
		}
	}

	function readLayoutColumns(value: unknown): number {
		return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2
			? value
			: 1;
	}

	function readLayoutColumn(value: unknown): number | null {
		return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2
			? value
			: null;
	}

	function layoutColumnsForBlockIndex(index: number): number {
		let columns = 1;
		for (let fieldIndex = 0; fieldIndex <= index; fieldIndex += 1) {
			const field = orderedDraftBlocks[fieldIndex];
			if (!field) continue;
			if (getBlockType(field) === 'layout_row') {
				columns = readLayoutColumns(field.layout_columns);
			}
		}
		return columns;
	}

	function buildLayoutSections(fields: ScreenField[]): LayoutSection[] {
		const sections: LayoutSection[] = [{ id: 'implicit-layout-row', columns: 1, items: [] }];
		let current = sections[0];
		for (const [index, field] of fields.entries()) {
			if (getBlockType(field) === 'layout_row') {
				current = {
					id: field.block_id ?? `layout-row-${index}`,
					columns: readLayoutColumns(field.layout_columns),
					row: { field, index },
					items: []
				};
				sections.push(current);
				continue;
			}
			current.items.push({ field, index });
		}
		return sections.filter(
			(section, index) => index === 0 || section.row || section.items.length > 0
		);
	}

	function previewGridColumn(field: ScreenField, columns: number): string | undefined {
		const column = readLayoutColumn(field.layout_column);
		if (!column || columns < 2) return undefined;
		return `${Math.min(column, columns)} / span 1`;
	}

	function displayColumnForItem(
		field: ScreenField,
		positionInSection: number,
		columns: number
	): number {
		const explicitColumn = readLayoutColumn(field.layout_column);
		if (explicitColumn && columns > 1) return Math.min(explicitColumn, columns);
		if (columns < 2) return 1;
		return (positionInSection % columns) + 1;
	}

	function builderColumnItems(section: LayoutSection, column: number) {
		return section.items.filter(
			(item, position) => displayColumnForItem(item.field, position, section.columns) === column
		);
	}

	function dropIndexForColumnEnd(section: LayoutSection, column: number): number {
		const columnItems = builderColumnItems(section, column);
		if (columnItems.length > 0) return columnItems[columnItems.length - 1].index + 1;
		if (section.items.length > 0) return section.items[section.items.length - 1].index + 1;
		if (section.row) return section.row.index + 1;
		return orderedDraftBlocks.length;
	}

	function columnLabel(column: number): string {
		return column === 1 ? t('左カラム', 'Left column') : t('右カラム', 'Right column');
	}

	function isDropTarget(index: number, column: number | null = null): boolean {
		return dropTargetIndex === index && dropTargetColumn === column;
	}

	function updateIdentitySchemaField(field: string) {
		const option = selectedSchemaOption(field);
		updateField(selectedBlockIndex, {
			field,
			label: option?.label ?? field,
			value_type: option?.valueType ?? 'text',
			required:
				draft.screen_kind === 'registration' && option?.schemaId
					? option.registrationRequired
					: (selectedBlock?.required ?? false)
		});
	}

	function createBlock(
		type: ScreenBlockType,
		order: number,
		patch: Partial<ScreenField> = {}
	): ScreenField {
		const blockId = patch.block_id ?? createBlockId(type);
		if (type === 'layout_row') {
			return {
				field: patch.field ?? `layout.${blockId}`,
				label: patch.label ?? 'Layout row',
				required: false,
				block_type: type,
				block_id: blockId,
				layout_columns: readLayoutColumns(patch.layout_columns),
				order,
				...patch
			};
		}
		if (type === 'auth_widget') {
			const method = normalizeAuthMethod(patch.auth_method);
			return {
				field: patch.field ?? `auth.${method}`,
				label: patch.label ?? authWidgetDefaultLabel(method),
				required: patch.required ?? false,
				block_type: type,
				block_id: blockId,
				order,
				...patch,
				auth_method: method,
				external_idp_show_action_text:
					method === 'external_idp' ? (patch.external_idp_show_action_text ?? false) : undefined
			};
		}
		if (type === 'code_input_widget') {
			const mode = normalizeCodeInputMode(patch.code_input_mode ?? patch.auth_method);
			return {
				field: patch.field ?? `auth.code_input.${mode}`,
				label: patch.label ?? codeInputDefaultLabel(mode),
				required: patch.required ?? true,
				block_type: type,
				block_id: blockId,
				auth_method: mode === 'auto' ? 'mail_otp' : mode,
				code_input_mode: mode,
				text:
					patch.text ??
					t(
						'メールまたは認証アプリのコードを入力してください。',
						'Enter the code from your email or authenticator app.'
					),
				order,
				...patch
			};
		}
		if (type === 'consent_widget') {
			return {
				field: patch.field ?? `consent.${blockId}`,
				label: patch.label ?? t('同意確認', 'Consent confirmation'),
				required: patch.required ?? true,
				block_type: type,
				block_id: blockId,
				text:
					patch.text ??
					t(
						'Flowの同意ポリシーとDestination Profileの必須・任意項目をここに表示します。',
						'The Flow consent policy and Destination Profile fields are rendered here.'
					),
				order,
				...patch
			};
		}
		if (isAccountWidgetType(type)) {
			const part = accountWidgetPart(type);
			return {
				field: patch.field ?? `account.${type.replace(/^account_|_widget$/gu, '')}`,
				label: patch.label ?? (part ? t(part.labelJa, part.labelEn) : 'Account widget'),
				required: false,
				block_type: type,
				block_id: blockId,
				order,
				...patch
			};
		}
		if (type === 'heading') {
			return {
				field: patch.field ?? `heading.${blockId}`,
				label: patch.label ?? t('見出し', 'Heading'),
				required: false,
				block_type: type,
				block_id: blockId,
				text: patch.text ?? '',
				order,
				...patch
			};
		}
		if (type === 'text') {
			return {
				field: patch.field ?? `text.${blockId}`,
				label: patch.label ?? 'Text',
				required: false,
				block_type: type,
				block_id: blockId,
				text: patch.text ?? 'Add helper text here.',
				order,
				...patch
			};
		}
		if (type === 'link') {
			return {
				field: patch.field ?? `link.${blockId}`,
				label: patch.label ?? t('詳細を見る', 'Learn more'),
				required: false,
				block_type: type,
				block_id: blockId,
				href: patch.href ?? '#profile',
				order,
				...patch
			};
		}
		if (type === 'security_verification') {
			return {
				field: patch.field ?? `security.${blockId}`,
				label: patch.label ?? t('セキュリティ確認', 'Security check'),
				required: false,
				block_type: type,
				block_id: blockId,
				text: patch.text ?? t('私は人間です', 'I am human'),
				order,
				...patch,
				human_verification_timing: normalizeHumanVerificationTiming(patch.human_verification_timing)
			};
		}
		if (type === 'divider') {
			return {
				field: patch.field ?? `divider.${blockId}`,
				label: patch.label ?? 'Divider',
				required: false,
				block_type: type,
				block_id: blockId,
				text: patch.text ?? '',
				order,
				...patch
			};
		}
		return {
			field: patch.field ?? 'email',
			label: patch.label ?? 'Email',
			required: patch.required ?? false,
			block_type: 'identity_field',
			block_id: blockId,
			value_type: normalizeValueType(patch.value_type),
			layout_column: readLayoutColumn(patch.layout_column),
			order,
			...patch
		};
	}

	function normalizeBlocks(fields: ScreenField[]): ScreenField[] {
		const source =
			fields.length > 0
				? fields
				: [createBlock('identity_field', 10, { field: 'email', label: 'Email' })];
		const seen = new SvelteSet<string>();
		return source
			.map((field, index) => {
				const baseId = normalizeInternalId(field.block_id ?? createStableBlockId(field, index));
				let blockId = baseId;
				let suffix = 2;
				while (seen.has(blockId)) {
					blockId = `${baseId}-${suffix}`;
					suffix += 1;
				}
				seen.add(blockId);
				return createBlock(getBlockType(field), field.order ?? (index + 1) * 10, {
					...field,
					block_id: blockId,
					display_condition: normalizeDisplayCondition(field.display_condition)
				});
			})
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}

	function blockTitle(block: ScreenField): string {
		const type = getBlockType(block);
		if (type === 'identity_field') return block.label || block.field;
		if (type === 'auth_widget')
			return block.label || authWidgetDefaultLabel(selectedAuthWidgetMethod(block));
		if (type === 'code_input_widget')
			return block.label || codeInputDefaultLabel(selectedCodeInputMode(block));
		if (type === 'consent_widget') return block.label || t('同意確認', 'Consent confirmation');
		if (type === 'heading') return block.label || t('見出し', 'Heading');
		if (type === 'text') return block.label || 'Text';
		if (type === 'link') return block.label || t('リンク', 'Link');
		if (type === 'security_verification')
			return block.label || t('セキュリティ確認', 'Security check');
		if (type === 'layout_row') return block.label || 'Layout row';
		return block.label || 'Divider';
	}

	function blockSubtitle(block: ScreenField): string {
		const type = getBlockType(block);
		const condition = supportsDisplayCondition(type) ? displayConditionLabel(block) : '';
		const withCondition = (value: string) => [value, condition].filter(Boolean).join(' / ');
		if (type === 'identity_field')
			return withCondition(`${block.field} / ${normalizeValueType(block.value_type)}`);
		if (type === 'auth_widget') return authMethodLabel(selectedAuthWidgetMethod(block));
		if (type === 'code_input_widget') {
			const mode = selectedCodeInputMode(block);
			return codeInputModeOptions.find((option) => option.value === mode)
				? t(
						codeInputModeOptions.find((option) => option.value === mode)?.labelJa ?? '自動',
						codeInputModeOptions.find((option) => option.value === mode)?.labelEn ?? 'Auto'
					)
				: t('自動', 'Auto');
		}
		if (type === 'consent_widget') return block.text ?? t('同意ポリシー', 'Consent policy');
		if (type === 'heading') return withCondition(block.text ?? '');
		if (type === 'text') return withCondition(block.text ?? '');
		if (type === 'link') return block.href ?? '';
		if (type === 'security_verification')
			return humanVerificationTimingLabel(block.human_verification_timing);
		if (type === 'layout_row') {
			const columns = readLayoutColumns(block.layout_columns);
			return withCondition(columns === 1 ? t('1カラム', '1 column') : t('2カラム', '2 columns'));
		}
		return withCondition(dividerLabel(block) || t('区切り線', 'Divider'));
	}

	function dividerLabel(field: ScreenField): string {
		return field.text ?? '';
	}

	function blockKey(block: ScreenField, index: number): string {
		return block.block_id ?? `${block.field}-${index}`;
	}

	function localizationKey(block: ScreenField, index = 0): string {
		return block.block_id ?? blockKey(block, index);
	}

	function legacyLocalizationKey(block: ScreenField, index = 0): string {
		return `${block.field}-${index}`;
	}

	function localizationLookupKeys(block: ScreenField, index = 0): string[] {
		return Array.from(
			new Set([localizationKey(block, index), legacyLocalizationKey(block, index)])
		);
	}

	function authWidgetDefaultLocalizationSource(block: ScreenField): string {
		const label = block.label;
		if (isDefaultScreenText(label)) return label;
		const method = selectedAuthWidgetMethod(block);
		if (method === 'mail_otp') return 'Send code by email';
		if (method === 'mail_otp_totp') return 'Mail OTP + authenticator app';
		if (method === 'totp') {
			return draft.screen_kind === 'registration'
				? 'Create account with authenticator app'
				: 'Sign in with authenticator app';
		}
		if (method === 'external_idp') return 'Ext. IdP';
		if (method === 'directory_password') return 'Sign in';
		return draft.screen_kind === 'registration'
			? 'Create Account with Passkey'
			: 'Sign in with Passkey';
	}

	function identityFieldLocalizationSource(block: ScreenField): string {
		if (block.field === 'email') return 'Email';
		if (block.field === 'name') return 'Name';
		if (block.field === 'given_name') return 'First Name';
		if (block.field === 'family_name') return 'Last Name';
		if (block.field === 'preferred_username') return 'Preferred username';
		return block.label || block.field;
	}

	function codeInputLocalizationSource(block: ScreenField): string {
		const label = block.label;
		if (isDefaultScreenText(label)) return label;
		const mode = selectedCodeInputMode(block);
		if (mode === 'mail_otp') return 'Email verification code';
		if (mode === 'totp') return 'Authenticator app code';
		return 'Authentication code';
	}

	function blockLocalizationSource(block: ScreenField): string {
		const type = getBlockType(block);
		if (type === 'identity_field') return identityFieldLocalizationSource(block);
		if (type === 'auth_widget') return authWidgetDefaultLocalizationSource(block);
		if (type === 'code_input_widget') return codeInputLocalizationSource(block);
		if (type === 'consent_widget')
			return isDefaultScreenText(block.label) ? block.label : 'Consent confirmation';
		if (type === 'heading') return isDefaultScreenText(block.label) ? block.label : 'Heading';
		if (type === 'text') return isDefaultScreenText(block.label) ? block.label : 'Text';
		if (type === 'security_verification')
			return isDefaultScreenText(block.label) ? block.label : 'Security check';
		if (type === 'divider') {
			const source = dividerLabel(block) || block.label;
			return isDefaultScreenText(source) ? source : source || 'Divider';
		}
		return block.label || block.field;
	}

	function existingLocalizedFieldLabel(
		block: ScreenField,
		language: ScreenLocalizationLanguage,
		index = 0
	): string | undefined {
		const fields = draft.localizations[language]?.fields ?? {};
		for (const key of localizationLookupKeys(block, index)) {
			const label = fields[key]?.label;
			if (typeof label === 'string') return label;
		}
		return undefined;
	}

	function localizedFieldLabel(
		block: ScreenField,
		language: ScreenLocalizationLanguage,
		index = 0
	): string {
		return mergeLocalizedDefaultScreenText(
			existingLocalizedFieldLabel(block, language, index),
			blockLocalizationSource(block),
			language
		);
	}

	function localizedFieldPlaceholder(
		block: ScreenField,
		language: ScreenLocalizationLanguage,
		index = 0
	): string {
		return (
			localizeDefaultScreenText(blockLocalizationSource(block), language) ||
			existingLocalizedFieldLabel(block, language, index) ||
			block.label ||
			block.field
		);
	}

	function updateLocalizationLabel(
		block: ScreenField,
		language: ScreenLocalizationLanguage,
		value: string,
		index = 0
	) {
		const key = localizationKey(block, index);
		const languageDraft = draft.localizations[language] ?? {};
		const fields = { ...(languageDraft.fields ?? {}) };
		fields[key] = { ...(fields[key] ?? {}), label: value };
		draft.localizations = {
			...draft.localizations,
			[language]: {
				...languageDraft,
				fields
			}
		};
	}

	function sanitizeLocalizationsForSave(
		localizations: Record<string, ScreenLocalization>,
		fields: ScreenField[]
	): Record<string, ScreenLocalization> {
		const allowedKeys = new Set(fields.map((field, index) => localizationKey(field, index)));
		const next: Record<string, ScreenLocalization> = {};
		for (const [language, localization] of Object.entries(localizations)) {
			const localizedFields: NonNullable<ScreenLocalization['fields']> = {};
			for (const [fieldKey, fieldLocalization] of Object.entries(localization.fields ?? {})) {
				if (!allowedKeys.has(fieldKey)) continue;
				const label = fieldLocalization.label?.trim();
				const text = fieldLocalization.text?.trim();
				const helpText = fieldLocalization.help_text?.trim();
				const placeholder = fieldLocalization.placeholder?.trim();
				if (!label && !text && !helpText && !placeholder) continue;
				localizedFields[fieldKey] = {
					...(label ? { label } : {}),
					...(text ? { text } : {}),
					...(helpText ? { help_text: helpText } : {}),
					...(placeholder ? { placeholder } : {})
				};
			}
			if (Object.keys(localizedFields).length > 0) {
				next[language] = {
					...localization,
					fields: localizedFields
				};
			}
		}
		return next;
	}

	function localizationsWithDefaultLabels(
		localizations: Record<string, ScreenLocalization>,
		fields: ScreenField[]
	): Record<string, ScreenLocalization> {
		const next: Record<string, ScreenLocalization> = { ...localizations };
		for (const language of SCREEN_LOCALIZATION_LANGUAGES) {
			const languageDraft = next[language] ?? {};
			const localizedFields: NonNullable<ScreenLocalization['fields']> = {
				...(languageDraft.fields ?? {})
			};
			for (const [index, field] of fields.entries()) {
				if (getBlockType(field) === 'layout_row') continue;
				const key = localizationKey(field, index);
				const label = localizedFieldLabel(field, language, index).trim();
				if (!label) continue;
				localizedFields[key] = {
					...(localizedFields[key] ?? {}),
					label
				};
			}
			next[language] = {
				...languageDraft,
				fields: localizedFields
			};
		}
		return next;
	}

	function authMethodLabel(value: string | null | undefined): string {
		return authMethodOptions.find((option) => option.value === value)?.label ?? value ?? 'Passkey';
	}

	function toBoolean(value: boolean | number): boolean {
		return value === true || value === 1;
	}

	function kindLabel(kind: ScreenKind): string {
		switch (kind) {
			case 'registration':
				return $LL.admin_screens_kind_registration();
			case 'profile_completion':
				return $LL.admin_screens_kind_profile_completion();
			case 'login':
				return $LL.admin_screens_kind_login();
			case 'consent':
				return $LL.admin_screens_kind_consent();
			case 'code_input':
				return $LL.admin_screens_kind_code_input();
			case 'account':
				return t('アカウント', 'Account');
			case 'custom':
			default:
				return $LL.admin_screens_kind_custom();
		}
	}

	function selectScreen(screen: Screen) {
		selectedId = screen.id;
		viewMode = 'preview';
		draft = {
			id: screen.id,
			screen_key: screen.screen_key,
			display_name: screen.display_name,
			description: screen.description ?? '',
			screen_kind: screen.screen_kind,
			fields: normalizeBlocks(screen.fields),
			localizations: screen.localizations ?? {},
			settings: normalizeSettings(screen.settings),
			is_active: toBoolean(screen.is_active),
			is_system: toBoolean(screen.is_system)
		};
		synchronizeDraftRegistrationRequirements();
		selectedBlockIndex = 0;
	}

	function newScreen() {
		selectedId = null;
		viewMode = 'edit';
		editorTab = 'items';
		draft = createEmptyDraft();
		synchronizeDraftRegistrationRequirements();
		selectedBlockIndex = 0;
		message = '';
		error = '';
	}

	function editScreen() {
		if (!selectedScreen) return;
		selectScreen(selectedScreen);
		if (selectedScreen.is_system) {
			const baseKey = selectedScreen.screen_key;
			draft = {
				...draft,
				id: null,
				screen_key: `${baseKey}_custom_${Date.now().toString(36)}`.slice(0, 96),
				display_name: `${selectedScreen.display_name} copy`,
				is_system: false,
				settings: { ...draft.settings, base_preset_key: baseKey, base_preset_version: 1 }
			};
			selectedId = null;
		}
		viewMode = 'edit';
		editorTab = 'items';
	}

	function resetScreenPreset() {
		const baseKey = draft.settings.base_preset_key;
		const preset = screens.find((screen) => screen.is_system && screen.screen_key === baseKey);
		if (
			!preset ||
			!confirm(
				t('元のプリセット内容に戻しますか？', 'Reset this custom screen to its base preset?')
			)
		)
			return;
		draft = {
			...draft,
			fields: normalizeBlocks(preset.fields),
			localizations: preset.localizations ?? {},
			settings: {
				...normalizeSettings(preset.settings),
				base_preset_key: preset.screen_key,
				base_preset_version: 1
			}
		};
		synchronizeDraftRegistrationRequirements();
	}

	function updateScreenKind(screenKind: ScreenKind) {
		draft.screen_kind = screenKind;
		synchronizeDraftRegistrationRequirements();
	}

	async function loadScreens() {
		loading = true;
		error = '';
		try {
			const response = await adminScreensAPI.list();
			screens = response.screens;
			if (!selectedId && screens.length > 0) selectScreen(screens[0]);
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : $LL.admin_screens_load_failed();
		} finally {
			loading = false;
		}
	}

	function removeField(index: number) {
		draft.fields = draft.fields.filter((_, fieldIndex) => fieldIndex !== index);
		selectedBlockIndex = Math.max(0, Math.min(selectedBlockIndex, draft.fields.length - 1));
	}

	function updateField(index: number, patch: Partial<ScreenField>) {
		draft.fields = draft.fields.map((field, fieldIndex) =>
			fieldIndex === index ? { ...field, ...patch } : field
		);
	}

	function normalizeOrders(fields: ScreenField[]): ScreenField[] {
		return fields.map((field, index) => ({ ...field, order: (index + 1) * 10 }));
	}

	function addBlock(
		type: ScreenBlockType,
		atIndex = draft.fields.length,
		patch: Partial<ScreenField> = {}
	) {
		const next = [...orderedDraftBlocks];
		const firstSchema = identitySchemaOptions[0];
		next.splice(
			atIndex,
			0,
			createBlock(type, (atIndex + 1) * 10, {
				...(type === 'identity_field' && firstSchema
					? {
							field: firstSchema.field,
							label: firstSchema.label,
							value_type: firstSchema.valueType,
							required:
								draft.screen_kind === 'registration' && firstSchema.schemaId
									? firstSchema.registrationRequired
									: false
						}
					: {}),
				...patch
			})
		);
		draft.fields = normalizeOrders(next);
		selectedBlockIndex = atIndex;
		editorTab = 'items';
	}

	function addRequiredRegistrationFields(options: RegistrationSchemaFieldOption[]) {
		if (options.length === 0) return;
		const next = [...orderedDraftBlocks];
		const firstDividerIndex = next.findIndex((field) => getBlockType(field) === 'divider');
		const insertionIndex = firstDividerIndex >= 0 ? firstDividerIndex : next.length;

		for (const [offset, option] of options.entries()) {
			next.splice(
				insertionIndex + offset,
				0,
				createBlock('identity_field', (insertionIndex + offset + 1) * 10, {
					field: option.field,
					label: option.label,
					value_type: option.valueType,
					required: true
				})
			);
		}

		draft.fields = normalizeOrders(next);
		selectedBlockIndex = insertionIndex;
		editorTab = 'items';
	}

	function moveBlock(fromIndex: number, toIndex: number, patch: Partial<ScreenField> = {}) {
		const next = [...orderedDraftBlocks];
		if (fromIndex < 0 || fromIndex >= next.length) return;
		const [item] = next.splice(fromIndex, 1);
		next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, { ...item, ...patch });
		draft.fields = normalizeOrders(next);
		selectedBlockIndex = Math.max(0, Math.min(toIndex, next.length - 1));
	}

	function handlePartDragStart(event: DragEvent, type: ScreenBlockType) {
		draggedPartType = type;
		draggedBlockIndex = null;
		event.dataTransfer?.setData('text/plain', `part:${type}`);
		event.dataTransfer?.setDragImage?.(event.currentTarget as Element, 12, 12);
	}

	function handleBlockDragStart(event: DragEvent, index: number) {
		draggedBlockIndex = index;
		draggedPartType = null;
		event.dataTransfer?.setData('text/plain', `block:${index}`);
		event.dataTransfer?.setDragImage?.(event.currentTarget as Element, 12, 12);
	}

	function handleCanvasDragOver(event: DragEvent, index: number, column: number | null = null) {
		event.preventDefault();
		event.stopPropagation();
		dropTargetIndex = index;
		dropTargetColumn = column;
	}

	function handleCanvasDrop(event: DragEvent, index: number, column: number | null = null) {
		event.preventDefault();
		event.stopPropagation();
		const layoutColumnPatch =
			column && column > 1 ? { layout_column: column } : column === 1 ? { layout_column: 1 } : {};
		if (draggedPartType) {
			addBlock(draggedPartType, index, draggedPartType === 'layout_row' ? {} : layoutColumnPatch);
		} else if (draggedBlockIndex !== null) {
			const adjustedIndex = draggedBlockIndex < index ? index - 1 : index;
			const draggedBlock = orderedDraftBlocks[draggedBlockIndex];
			moveBlock(
				draggedBlockIndex,
				adjustedIndex,
				draggedBlock && getBlockType(draggedBlock) === 'layout_row' ? {} : layoutColumnPatch
			);
		}
		draggedPartType = null;
		draggedBlockIndex = null;
		dropTargetIndex = null;
		dropTargetColumn = null;
	}

	function clearDragState() {
		draggedPartType = null;
		draggedBlockIndex = null;
		dropTargetIndex = null;
		dropTargetColumn = null;
	}

	async function saveProfile() {
		saving = true;
		error = '';
		message = '';
		try {
			const body = {
				screen_key: draft.screen_key,
				display_name: draft.display_name,
				description: draft.description || null,
				screen_kind: draft.screen_kind,
				fields: orderedDraftBlocks.map((field, index) => ({
					...field,
					block_id: localizationKey(field, index),
					order: (index + 1) * 10
				})),
				localizations: sanitizeLocalizationsForSave(
					localizationsWithDefaultLabels(draft.localizations, orderedDraftBlocks),
					orderedDraftBlocks
				),
				settings: normalizeSettings(draft.settings),
				is_active: draft.is_active
			};
			if (draft.id) {
				await adminScreensAPI.update(draft.id, body);
			} else {
				const response = await adminScreensAPI.create(body);
				selectedId = response.screen.id;
			}
			message = $LL.admin_screens_saved();
			await loadScreens();
			const next = screens.find((screen) => screen.id === selectedId);
			if (next) selectScreen(next);
			viewMode = 'preview';
		} catch (saveError) {
			error = saveError instanceof Error ? saveError.message : $LL.admin_screens_save_failed();
		} finally {
			saving = false;
		}
	}

	async function deleteScreen() {
		if (!draft.id || draft.is_system) return;
		if (!confirm($LL.admin_screens_delete_confirm())) return;
		saving = true;
		error = '';
		message = '';
		try {
			await adminScreensAPI.delete(draft.id);
			selectedId = null;
			viewMode = 'preview';
			draft = createEmptyDraft();
			message = $LL.admin_screens_deleted();
			await loadScreens();
		} catch (deleteError) {
			error =
				deleteError instanceof Error ? deleteError.message : $LL.admin_screens_delete_failed();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_screens_page_title()}</title>
</svelte:head>

{#snippet canvasBlock(field: ScreenField, index: number)}
	<article
		class:active={selectedBlockIndex === index}
		class:layout-block={getBlockType(field) === 'layout_row'}
		class="canvas-block"
	>
		<button
			type="button"
			class="drag-handle"
			draggable="true"
			aria-label={t('ドラッグして移動', 'Drag to move')}
			ondragstart={(event) => handleBlockDragStart(event, index)}
			ondragend={clearDragState}
			onclick={(event) => event.stopPropagation()}
		>
			<span aria-hidden="true"></span>
		</button>
		<button type="button" class="block-select" onclick={() => (selectedBlockIndex = index)}>
			<span class="block-main">
				<strong>{blockTitle(field)}</strong>
				<small>{blockSubtitle(field)}</small>
			</span>
		</button>
		<div class="block-actions">
			<button
				type="button"
				class="icon-button danger"
				aria-label={$LL.admin_screens_remove_field()}
				onclick={(event) => {
					event.stopPropagation();
					removeField(index);
				}}
			>
				<span class="i-ph-trash"></span>
			</button>
		</div>
	</article>
{/snippet}

<AdminPageShell>
	<AdminPageHeader title={$LL.admin_screens_title()} description={$LL.admin_screens_description()}>
		{#snippet actions()}
			<button class="btn-secondary" type="button" onclick={newScreen}>
				<span class="i-ph-plus"></span>
				{$LL.admin_screens_create()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert error">{error}</div>
	{/if}
	{#if message}
		<div class="alert success">{message}</div>
	{/if}

	<AdminSection>
		{#if loading}
			<p class="muted">{$LL.admin_screens_loading()}</p>
		{:else}
			<div class:editing={viewMode === 'edit'} class="layout">
				{#if viewMode === 'preview'}
					<aside class="screen-list" aria-label={$LL.admin_screens_title()}>
						{#if screens.length === 0}
							<p class="muted">{$LL.admin_screens_empty()}</p>
						{:else}
							{#each screens as screen (screen.id)}
								<button
									type="button"
									class:active={selectedScreen?.id === screen.id}
									class="screen-row"
									onclick={() => selectScreen(screen)}
								>
									<span>{screen.display_name}</span>
									<small>{kindLabel(screen.screen_kind)}</small>
								</button>
							{/each}
						{/if}
					</aside>
				{/if}

				<section class="detail-panel" aria-label={$LL.admin_screens_select_screen()}>
					{#if viewMode === 'preview'}
						{#if selectedScreen}
							<div class="preview-head">
								<div>
									<h2>{selectedScreen.display_name}</h2>
									<div class="preview-meta">
										<span>{kindLabel(selectedScreen.screen_kind)}</span>
										<span>{selectedScreen.screen_key}</span>
										{#if toBoolean(selectedScreen.is_system)}
											<span>{$LL.admin_screens_system()}</span>
										{/if}
										{#if toBoolean(selectedScreen.is_active)}
											<span>{$LL.admin_screens_active()}</span>
										{/if}
									</div>
								</div>
								<button class="btn-edit" type="button" onclick={editScreen}>
									<span class="i-ph-pencil-simple"></span>
									{$LL.admin_screens_edit()}
								</button>
							</div>

							<div
								class:wide-canvas={normalizeSettings(selectedScreen.settings).canvas_layout ===
									'wide'}
								class="screen-preview"
								aria-label={$LL.admin_screens_preview()}
							>
								{#if previewLayoutSections.every((section) => section.items.length === 0)}
									<p class="muted">{$LL.admin_screens_no_fields()}</p>
								{:else}
									{#each previewLayoutSections as section (section.id)}
										{#if section.items.length > 0}
											<div
												class="preview-layout-row"
												style={`grid-template-columns: repeat(${section.columns}, minmax(0, 1fr));`}
											>
												{#each section.items as item (blockKey(item.field, item.index))}
													{@const field = item.field}
													{@const blockType = getBlockType(field)}
													{@const gridColumn = previewGridColumn(field, section.columns)}
													<div
														class="preview-layout-cell"
														style={gridColumn ? `grid-column: ${gridColumn};` : undefined}
													>
														{#if blockType === 'identity_field'}
															<div class="preview-field">
																<span>
																	{field.label || field.field}
																	{#if field.required}
																		<strong>{$LL.admin_screens_required_mark()}</strong>
																	{/if}
																</span>
																{#if normalizeValueType(field.value_type) === 'boolean'}
																	<label class="preview-check-field">
																		<input type="checkbox" disabled />
																		<span>{field.placeholder ?? field.label ?? field.field}</span>
																	</label>
																{:else}
																	<input
																		readonly
																		value={field.placeholder ?? ''}
																		placeholder={field.placeholder ?? field.label ?? field.field}
																	/>
																{/if}
																{#if field.help_text}
																	<small>{field.help_text}</small>
																{/if}
															</div>
														{:else if blockType === 'auth_widget'}
															{@const method = selectedAuthWidgetMethod(field)}
															<div class="preview-auth-widget" aria-label={authMethodLabel(method)}>
																{#if method === 'mail_otp'}
																	{#if shouldShowAuthWidgetEmailInput(selectedScreen.screen_kind, previewFields)}
																		<div class="preview-field">
																			<span>{t('メールアドレス', 'Email address')}</span>
																			<input readonly placeholder="you@example.com" />
																		</div>
																	{/if}
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-envelope-simple"></span>
																		{authWidgetDisplayLabel(field, method)}
																	</button>
																{:else if method === 'mail_otp_totp'}
																	<div class="preview-field">
																		<span>{t('メールアドレス', 'Email address')}</span>
																		<input readonly placeholder="you@example.com" />
																	</div>
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-envelope-simple"></span>
																		{t('認証コードをメール送信', 'Send code by email')}
																	</button>
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-device-mobile"></span>
																		{t('認証アプリでログイン', 'Sign in with authenticator app')}
																	</button>
																{:else if method === 'directory_password'}
																	<div class="preview-field">
																		<span>{t('ユーザー名', 'Username')}</span>
																		<input readonly placeholder={t('ユーザー名', 'Username')} />
																	</div>
																	<div class="preview-field">
																		<span>{t('パスワード', 'Password')}</span>
																		<input readonly type="password" value="password" />
																	</div>
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-identification-card"></span>
																		{authWidgetDisplayLabel(field, method)}
																	</button>
																{:else if method === 'totp'}
																	<div class="preview-field">
																		<span>{t('メールアドレス', 'Email address')}</span>
																		<input readonly placeholder="you@example.com" />
																	</div>
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-device-mobile"></span>
																		{authWidgetDisplayLabel(field, method)}
																	</button>
																{:else if method === 'external_idp'}
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-globe"></span>
																		{externalIdpPreviewLabel(field)}
																	</button>
																{:else}
																	<button class="preview-auth-button" type="button">
																		<span class="i-ph-key"></span>
																		{authWidgetDisplayLabel(field, method)}
																	</button>
																{/if}
															</div>
														{:else if blockType === 'code_input_widget'}
															{@const mode = selectedCodeInputMode(field)}
															<div class="preview-code-input-widget">
																<div class="preview-field">
																	<span>{field.label || codeInputDefaultLabel(mode)}</span>
																	<input readonly placeholder="123456" />
																	{#if field.text}
																		<small>{field.text}</small>
																	{/if}
																</div>
																{#if mode !== 'totp'}
																	<div class="preview-code-progress" aria-hidden="true">
																		<span></span>
																	</div>
																	<div class="preview-code-actions">
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-arrow-left"></span>
																			{t('戻る', 'Back')}
																		</button>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-arrow-clockwise"></span>
																			{t('再送信', 'Resend')}
																		</button>
																	</div>
																{:else}
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-arrow-left"></span>
																		{t('戻る', 'Back')}
																	</button>
																{/if}
																<button class="preview-auth-button" type="button">
																	<span class="i-ph-check-circle"></span>
																	{t('確認', 'Verify')}
																</button>
															</div>
														{:else if blockType === 'consent_widget'}
															<div class="preview-consent-widget">
																<div class="preview-consent-widget__heading">
																	<span class="i-ph-handshake"></span>
																	<strong
																		>{field.label || t('同意確認', 'Consent confirmation')}</strong
																	>
																</div>
																<p>
																	{field.text ||
																		t(
																			'Flowの同意ポリシーとDestination Profileの項目がここに表示されます。',
																			'The Flow consent policy and Destination Profile fields are rendered here.'
																		)}
																</p>
																<label class="preview-check-field">
																	<input type="checkbox" disabled />
																	<span
																		>{t(
																			'内容を確認しました',
																			'I have reviewed the consent items'
																		)}</span
																	>
																</label>
															</div>
														{:else if isAccountWidgetType(blockType)}
															{@const part = accountWidgetPart(blockType)}
															<div class="preview-account-widget">
																<span class={part?.icon ?? 'i-ph-squares-four'}></span>
																<div>
																	<strong
																		>{field.label ||
																			(part ? t(part.labelJa, part.labelEn) : '')}</strong
																	>
																</div>
															</div>
														{:else if blockType === 'heading'}
															<div class="preview-heading-block">
																<h2>{field.label}</h2>
																{#if field.text}
																	<p>{field.text}</p>
																{/if}
															</div>
														{:else if blockType === 'text'}
															<p class="preview-static-text">{field.text || field.label}</p>
														{:else if blockType === 'link'}
															<a class="preview-static-link" href={safePreviewHref(field.href)}
																>{field.label}</a
															>
														{:else if blockType === 'security_verification'}
															<div class="preview-security-box">
																<span class="i-ph-shield-check"></span>
																<span>
																	{field.text || field.label}
																	<small
																		>{humanVerificationTimingLabel(
																			field.human_verification_timing
																		)}</small
																	>
																</span>
															</div>
														{:else if blockType === 'divider'}
															<div
																class="preview-divider"
																class:has-label={Boolean(dividerLabel(field))}
															>
																<span>{dividerLabel(field)}</span>
															</div>
														{/if}
													</div>
												{/each}
											</div>
										{/if}
									{/each}
								{/if}
							</div>
						{:else}
							<div class="empty-detail">
								<h2>{$LL.admin_screens_empty()}</h2>
								<p class="muted">{$LL.admin_screens_select_screen()}</p>
								<button class="btn-primary" type="button" onclick={newScreen}>
									<span class="i-ph-plus"></span>
									{$LL.admin_screens_create()}
								</button>
							</div>
						{/if}
					{:else}
						<div class="editor">
							<div class="editor-head">
								<h2>{draft.id ? draft.display_name : $LL.admin_screens_new_screen()}</h2>
								<label class="toggle">
									<input type="checkbox" bind:checked={draft.is_active} />
									<span>{$LL.admin_screens_active()}</span>
								</label>
							</div>

							<div class="note">{$LL.admin_screens_schema_required_note()}</div>

							{#if missingRequiredRegistrationFields.length > 0}
								<div class="required-fields-warning" role="status">
									<div class="required-fields-warning__heading">
										<span class="i-ph-warning-circle" aria-hidden="true"></span>
										<div>
											<strong
												>{t(
													'登録に必要な入力項目が不足しています',
													'Required registration fields are missing'
												)}</strong
											>
											<p>
												{t(
													'Identity Schemaで登録時必須に設定されている項目を、このスクリーンに追加できます。',
													'Add fields that Identity Schema marks as required during registration.'
												)}
											</p>
										</div>
									</div>
									<div class="required-fields-warning__list">
										{#each missingRequiredRegistrationFields as option (option.field)}
											<div class="required-fields-warning__item">
												<div>
													<strong>{option.label}</strong>
													<code>{option.field}</code>
												</div>
												<div class="required-fields-warning__actions">
													<button
														class="btn-secondary compact"
														type="button"
														onclick={() => addRequiredRegistrationFields([option])}
													>
														<span class="i-ph-plus" aria-hidden="true"></span>
														{t('入力欄を追加', 'Add field')}
													</button>
													{#if option.schemaId}
														<a
															class="btn-secondary compact"
															href={`/admin/custom-claims/${option.schemaId}`}
															target="_blank"
															rel="noreferrer"
														>
															{t('スキーマ設定', 'Schema settings')}
														</a>
													{/if}
												</div>
											</div>
										{/each}
									</div>
									<div class="required-fields-warning__footer">
										<p>
											{t(
												'この状態でも保存できます。先に保存してから、Identity Schemaで必須設定を外すこともできます。',
												'You can still save now and turn off the requirement later in Identity Schema.'
											)}
										</p>
										{#if missingRequiredRegistrationFields.length > 1}
											<button
												class="btn-primary compact"
												type="button"
												onclick={() =>
													addRequiredRegistrationFields(missingRequiredRegistrationFields)}
											>
												{t('不足項目をすべて追加', 'Add all missing fields')}
											</button>
										{/if}
									</div>
								</div>
							{/if}

							<div class="grid two">
								<label>
									<span>{$LL.admin_screens_screen_key()}</span>
									<input
										bind:value={draft.screen_key}
										disabled={draft.is_system || Boolean(draft.id)}
									/>
								</label>
								<label>
									<span>{$LL.admin_screens_kind()}</span>
									<select
										value={draft.screen_kind}
										onchange={(event) => updateScreenKind(event.currentTarget.value as ScreenKind)}
									>
										{#each kindOptions as kind (kind)}
											<option value={kind}>{kindLabel(kind)}</option>
										{/each}
									</select>
								</label>
							</div>

							<label>
								<span>{$LL.admin_screens_display_name()}</span>
								<input bind:value={draft.display_name} />
							</label>

							<label>
								<span>{$LL.admin_screens_description_label()}</span>
								<textarea rows="3" bind:value={draft.description}></textarea>
							</label>

							<label class="canvas-layout-select">
								<span>{t('キャンバス', 'Canvas')}</span>
								<select
									value={normalizeSettings(draft.settings).canvas_layout}
									onchange={(event) =>
										(draft.settings = {
											...draft.settings,
											canvas_layout: event.currentTarget.value as ScreenCanvasLayout
										})}
								>
									<option value="narrow">{t('縦長', 'Narrow')}</option>
									<option value="wide">{t('横長', 'Wide')}</option>
								</select>
							</label>

							<AdminTabs
								items={editorTabItems}
								active={editorTab}
								onChange={(tabId) => (editorTab = tabId as ScreenEditorTab)}
								ariaLabel={$LL.admin_screens_fields()}
							/>

							{#if editorTab === 'items'}
								<div class="tab-panel-head" id="screen-editor-items">
									<p class="muted">
										{t(
											'左のパーツを追加し、中央で順番を並べ替え、右で詳細を設定します。',
											'Add parts from the left, arrange them in the canvas, then configure them on the right.'
										)}
									</p>
								</div>

								<div class="screen-builder">
									<aside class="parts-panel" aria-label={t('スクリーンパーツ', 'Screen parts')}>
										{#each screenParts.filter(screenPartAvailable) as part (part.type)}
											<button
												type="button"
												class="part-card"
												draggable="true"
												ondragstart={(event) => handlePartDragStart(event, part.type)}
												ondragend={clearDragState}
												onclick={() => addBlock(part.type)}
											>
												<span class={part.icon}></span>
												<strong>{t(part.labelJa, part.labelEn)}</strong>
												<small>{t(part.descriptionJa, part.descriptionEn)}</small>
											</button>
										{/each}
									</aside>

									<section
										class="builder-canvas"
										aria-label={t('スクリーン配置', 'Screen canvas')}
										ondragover={(event) => handleCanvasDragOver(event, orderedDraftBlocks.length)}
										ondrop={(event) => handleCanvasDrop(event, orderedDraftBlocks.length)}
									>
										{#each draftLayoutSections as section (section.id)}
											{#if section.row}
												<button
													type="button"
													class:active={isDropTarget(section.row.index)}
													class="drop-zone"
													ondragover={(event) =>
														handleCanvasDragOver(event, section.row?.index ?? 0)}
													ondrop={(event) => handleCanvasDrop(event, section.row?.index ?? 0)}
												>
													{isDropTarget(section.row.index) ? t('ここに配置', 'Drop here') : ''}
												</button>
												{@render canvasBlock(section.row.field, section.row.index)}
											{/if}

											<div
												class:has-columns={section.columns > 1}
												class="builder-layout-row"
												style={`grid-template-columns: repeat(${section.columns}, minmax(0, 1fr));`}
											>
												{#each Array.from({ length: section.columns }, (_, columnIndex) => columnIndex + 1) as column (column)}
													{@const columnItems = builderColumnItems(section, column)}
													{@const columnEndIndex = dropIndexForColumnEnd(section, column)}
													<div
														class:empty={columnItems.length === 0}
														class="builder-layout-column"
														role="group"
														aria-label={section.columns > 1
															? columnLabel(column)
															: t('スクリーン行', 'Screen row')}
														ondragover={(event) =>
															handleCanvasDragOver(event, columnEndIndex, column)}
														ondrop={(event) => handleCanvasDrop(event, columnEndIndex, column)}
													>
														{#if section.columns > 1}
															<div class="builder-column-label">{columnLabel(column)}</div>
														{/if}
														{#each columnItems as item (blockKey(item.field, item.index))}
															<button
																type="button"
																class:active={isDropTarget(item.index, column)}
																class="drop-zone"
																ondragover={(event) =>
																	handleCanvasDragOver(event, item.index, column)}
																ondrop={(event) => handleCanvasDrop(event, item.index, column)}
															>
																{isDropTarget(item.index, column)
																	? t('ここに配置', 'Drop here')
																	: ''}
															</button>
															{@render canvasBlock(item.field, item.index)}
														{/each}
														<button
															type="button"
															class:active={isDropTarget(columnEndIndex, column)}
															class="drop-zone final column-drop"
															ondragover={(event) =>
																handleCanvasDragOver(event, columnEndIndex, column)}
															ondrop={(event) => handleCanvasDrop(event, columnEndIndex, column)}
														>
															{isDropTarget(columnEndIndex, column)
																? t('ここに配置', 'Drop here')
																: section.columns > 1
																	? t('このカラムにドラッグ', 'Drag into this column')
																	: t('パーツをここにドラッグ', 'Drag a part here')}
														</button>
													</div>
												{/each}
											</div>
										{/each}
										<button
											type="button"
											class:active={isDropTarget(orderedDraftBlocks.length)}
											class="drop-zone final"
											ondragover={(event) => handleCanvasDragOver(event, orderedDraftBlocks.length)}
											ondrop={(event) => handleCanvasDrop(event, orderedDraftBlocks.length)}
										>
											{isDropTarget(orderedDraftBlocks.length)
												? t('ここに配置', 'Drop here')
												: t('パーツをここにドラッグ', 'Drag a part here')}
										</button>
									</section>

									<aside class="inspector-panel" aria-label={t('パーツ設定', 'Part settings')}>
										{#if selectedBlock}
											{@const blockType = getBlockType(selectedBlock)}
											<h3>{t('パーツ設定', 'Part settings')}</h3>
											<label>
												<span>{t('内部ID', 'Internal ID')}</span>
												<input readonly value={selectedBlock.block_id ?? ''} />
											</label>
											<label>
												<span>{t('表示名', 'Label')}</span>
												<input
													value={selectedBlock.label}
													oninput={(event) =>
														updateField(selectedBlockIndex, { label: event.currentTarget.value })}
												/>
											</label>
											{#if supportsDisplayCondition(blockType)}
												<label>
													<span>{t('表示条件', 'Display condition')}</span>
													<select
														value={displayConditionMode(selectedBlock)}
														onchange={(event) =>
															updateDisplayConditionMode(
																event.currentTarget.value as ScreenDisplayConditionMode
															)}
													>
														{#each displayConditionModeOptions as option (option.value)}
															<option value={option.value}>
																{t(option.labelJa, option.labelEn)}
															</option>
														{/each}
													</select>
												</label>
												{#if displayConditionMode(selectedBlock) === 'feature_enabled'}
													<label>
														<span>{t('機能', 'Feature')}</span>
														<select
															value={displayConditionFeature(selectedBlock)}
															onchange={(event) =>
																updateDisplayConditionFeature(
																	event.currentTarget.value as ScreenDisplayConditionFeature
																)}
														>
															{#each displayConditionFeatureOptions as option (option.value)}
																<option value={option.value}>{option.label}</option>
															{/each}
														</select>
													</label>
												{/if}
											{/if}

											{#if blockType === 'layout_row'}
												<label>
													<span>{t('カラム数', 'Columns')}</span>
													<select
														value={readLayoutColumns(selectedBlock.layout_columns)}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																layout_columns: Number(event.currentTarget.value)
															})}
													>
														<option value="1">{t('1カラム', '1 column')}</option>
														<option value="2">{t('2カラム', '2 columns')}</option>
													</select>
												</label>
											{:else if blockType === 'identity_field'}
												<label>
													<span>Identity Schema</span>
													<select
														value={selectedBlock.field}
														onchange={(event) =>
															updateIdentitySchemaField(event.currentTarget.value)}
													>
														{#each identitySchemaOptions as option (option.field)}
															<option value={option.field}>
																{option.label} ({option.field})
															</option>
														{/each}
													</select>
												</label>
												<label>
													<span>{t('入力タイプ', 'Input type')}</span>
													<select
														value={normalizeValueType(selectedBlock.value_type)}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																value_type: event.currentTarget.value as ScreenValueType
															})}
													>
														<option value="text">text</option>
														<option value="boolean">boolean</option>
													</select>
												</label>
												{#if selectedBlockLayoutColumns > 1}
													<label>
														<span>{t('配置カラム', 'Layout column')}</span>
														<select
															value={readLayoutColumn(selectedBlock.layout_column) ?? ''}
															onchange={(event) =>
																updateField(selectedBlockIndex, {
																	layout_column: event.currentTarget.value
																		? Number(event.currentTarget.value)
																		: null
																})}
														>
															<option value="">{t('自動', 'Auto')}</option>
															<option value="1">{t('左カラム', 'Left column')}</option>
															<option value="2">{t('右カラム', 'Right column')}</option>
														</select>
													</label>
												{/if}
												<label>
													<span>{t('プレースホルダー', 'Placeholder')}</span>
													<input
														value={selectedBlock.placeholder ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, {
																placeholder: event.currentTarget.value
															})}
													/>
												</label>
												<label>
													<span>{t('ヘルプテキスト', 'Help text')}</span>
													<textarea
														rows="2"
														value={selectedBlock.help_text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, {
																help_text: event.currentTarget.value
															})}
													></textarea>
												</label>
												<label class="check">
													<input
														type="checkbox"
														checked={selectedBlock.required}
														disabled={schemaControlsRegistrationRequirement(selectedBlock.field)}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																required: event.currentTarget.checked
															})}
													/>
													<span>{$LL.admin_screens_field_required()}</span>
												</label>
												{#if schemaControlsRegistrationRequirement(selectedBlock.field)}
													<p class="note inspector-note">
														{t(
															'登録時の必須設定はIdentity Schemaで管理されています。',
															'Registration requirements are managed in Identity Schema.'
														)}
													</p>
												{/if}
											{:else if blockType === 'auth_widget'}
												<label>
													<span>{t('認証方式', 'Auth method')}</span>
													<select
														value={selectedAuthWidgetMethod(selectedBlock)}
														onchange={(event) => updateAuthWidgetMethod(event.currentTarget.value)}
													>
														{#each authMethodOptions as option (option.value)}
															<option value={option.value}>{option.label}</option>
														{/each}
													</select>
												</label>
												{#if selectedAuthWidgetMethod(selectedBlock) === 'external_idp'}
													<label class="check">
														<input
															type="checkbox"
															checked={selectedBlock.external_idp_show_action_text === true}
															onchange={(event) =>
																updateField(selectedBlockIndex, {
																	external_idp_show_action_text: event.currentTarget.checked
																})}
														/>
														<span>{$LL.admin_screens_external_idp_action_text_label()}</span>
													</label>
												{/if}
											{:else if blockType === 'code_input_widget'}
												<label>
													<span>{t('コード種別', 'Code type')}</span>
													<select
														value={selectedCodeInputMode(selectedBlock)}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																code_input_mode: normalizeCodeInputMode(event.currentTarget.value),
																auth_method:
																	event.currentTarget.value === 'auto'
																		? 'mail_otp'
																		: event.currentTarget.value,
																field: `auth.code_input.${event.currentTarget.value}`
															})}
													>
														{#each codeInputModeOptions as option (option.value)}
															<option value={option.value}
																>{t(option.labelJa, option.labelEn)}</option
															>
														{/each}
													</select>
												</label>
												<label>
													<span>{t('説明テキスト', 'Description text')}</span>
													<textarea
														rows="3"
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													></textarea>
												</label>
											{:else if blockType === 'consent_widget'}
												<label>
													<span>{t('説明テキスト', 'Description text')}</span>
													<textarea
														rows="3"
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													></textarea>
												</label>
												<label class="check">
													<input
														type="checkbox"
														checked={selectedBlock.required}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																required: event.currentTarget.checked
															})}
													/>
													<span>{$LL.admin_screens_field_required()}</span>
												</label>
											{:else if isAccountWidgetType(blockType)}
												<p class="muted">
													{t(
														'このWidgetはフォーム、操作ボタン、検証、ローディング、成功・エラーを自動的に管理します。',
														'This widget owns its form, actions, validation, loading, success, and error states.'
													)}
												</p>
											{:else if blockType === 'heading'}
												<label>
													<span>{t('補足テキスト（任意）', 'Supporting text (optional)')}</span>
													<textarea
														rows="2"
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													></textarea>
												</label>
											{:else if blockType === 'text'}
												<label>
													<span>{t('本文', 'Text')}</span>
													<textarea
														rows="5"
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													></textarea>
												</label>
											{:else if blockType === 'link'}
												<label>
													<span>{t('リンク先', 'Link destination')}</span>
													<input
														value={selectedBlock.href ?? ''}
														placeholder="#profile or https://example.com/help"
														oninput={(event) =>
															updateField(selectedBlockIndex, { href: event.currentTarget.value })}
													/>
												</label>
											{:else if blockType === 'security_verification'}
												<label>
													<span>{t('表示テキスト', 'Display text')}</span>
													<input
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													/>
												</label>
												<label>
													<span>{t('CAPTCHA表示', 'CAPTCHA display')}</span>
													<select
														value={normalizeHumanVerificationTiming(
															selectedBlock.human_verification_timing
														)}
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																human_verification_timing: normalizeHumanVerificationTiming(
																	event.currentTarget.value
																)
															})}
													>
														{#each humanVerificationTimingOptions as option (option.value)}
															<option value={option.value}>
																{t(option.labelJa, option.labelEn)}
															</option>
														{/each}
													</select>
												</label>
											{:else if blockType === 'divider'}
												<label>
													<span>{t('ラベル（任意）', 'Label (optional)')}</span>
													<input
														value={dividerLabel(selectedBlock)}
														placeholder={t('または', 'or')}
														oninput={(event) =>
															updateField(selectedBlockIndex, {
																text: event.currentTarget.value || null
															})}
													/>
												</label>
											{/if}
										{:else}
											<p class="muted">
												{t('設定するパーツを選択してください。', 'Select a part to configure.')}
											</p>
										{/if}
									</aside>
								</div>
							{:else if editorTab === 'preview'}
								<div class="screen-preview-toolbar">
									<select bind:value={screenPreviewViewport}
										><option value="desktop">Desktop</option><option value="mobile">Mobile</option
										></select
									>
								</div>
								<div
									class:wide-canvas={normalizeSettings(draft.settings).canvas_layout === 'wide'}
									class:mobile-preview={screenPreviewViewport === 'mobile'}
									class="screen-preview draft-preview"
									id="screen-editor-preview"
									aria-label={$LL.admin_screens_preview()}
								>
									{#if draftLayoutSections.every((section) => section.items.length === 0)}
										<p class="muted">{$LL.admin_screens_no_fields()}</p>
									{:else}
										{#each draftLayoutSections as section (section.id)}
											{#if section.items.length > 0}
												<div
													class="preview-layout-row"
													style={`grid-template-columns: repeat(${section.columns}, minmax(0, 1fr));`}
												>
													{#each section.items as item (blockKey(item.field, item.index))}
														{@const field = item.field}
														{@const blockType = getBlockType(field)}
														{@const gridColumn = previewGridColumn(field, section.columns)}
														<div
															class="preview-layout-cell"
															style={gridColumn ? `grid-column: ${gridColumn};` : undefined}
														>
															{#if blockType === 'identity_field'}
																<div class="preview-field">
																	<span>
																		{field.label || field.field}
																		{#if field.required}
																			<strong>{$LL.admin_screens_required_mark()}</strong>
																		{/if}
																	</span>
																	{#if normalizeValueType(field.value_type) === 'boolean'}
																		<label class="preview-check-field">
																			<input type="checkbox" disabled />
																			<span>{field.placeholder ?? field.label ?? field.field}</span>
																		</label>
																	{:else}
																		<input
																			readonly
																			value={field.placeholder ?? ''}
																			placeholder={field.placeholder ?? field.label ?? field.field}
																		/>
																	{/if}
																	{#if field.help_text}
																		<small>{field.help_text}</small>
																	{/if}
																</div>
															{:else if blockType === 'auth_widget'}
																{@const method = selectedAuthWidgetMethod(field)}
																<div
																	class="preview-auth-widget"
																	aria-label={authMethodLabel(method)}
																>
																	{#if method === 'mail_otp'}
																		{#if shouldShowAuthWidgetEmailInput(draft.screen_kind, orderedDraftBlocks)}
																			<div class="preview-field">
																				<span>{t('メールアドレス', 'Email address')}</span>
																				<input readonly placeholder="you@example.com" />
																			</div>
																		{/if}
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-envelope-simple"></span>
																			{authWidgetDisplayLabel(field, method)}
																		</button>
																	{:else if method === 'mail_otp_totp'}
																		<div class="preview-field">
																			<span>{t('メールアドレス', 'Email address')}</span>
																			<input readonly placeholder="you@example.com" />
																		</div>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-envelope-simple"></span>
																			{t('認証コードをメール送信', 'Send code by email')}
																		</button>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-device-mobile"></span>
																			{t('認証アプリでログイン', 'Sign in with authenticator app')}
																		</button>
																	{:else if method === 'directory_password'}
																		<div class="preview-field">
																			<span>{t('ユーザー名', 'Username')}</span>
																			<input readonly placeholder={t('ユーザー名', 'Username')} />
																		</div>
																		<div class="preview-field">
																			<span>{t('パスワード', 'Password')}</span>
																			<input readonly type="password" value="password" />
																		</div>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-identification-card"></span>
																			{authWidgetDisplayLabel(field, method)}
																		</button>
																	{:else if method === 'totp'}
																		<div class="preview-field">
																			<span>{t('メールアドレス', 'Email address')}</span>
																			<input readonly placeholder="you@example.com" />
																		</div>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-device-mobile"></span>
																			{authWidgetDisplayLabel(field, method)}
																		</button>
																	{:else if method === 'external_idp'}
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-globe"></span>
																			{externalIdpPreviewLabel(field)}
																		</button>
																	{:else}
																		<button class="preview-auth-button" type="button">
																			<span class="i-ph-key"></span>
																			{authWidgetDisplayLabel(field, method)}
																		</button>
																	{/if}
																</div>
															{:else if blockType === 'code_input_widget'}
																{@const mode = selectedCodeInputMode(field)}
																<div class="preview-code-input-widget">
																	<div class="preview-field">
																		<span>{field.label || codeInputDefaultLabel(mode)}</span>
																		<input readonly placeholder="123456" />
																		{#if field.text}
																			<small>{field.text}</small>
																		{/if}
																	</div>
																	{#if mode !== 'totp'}
																		<div class="preview-code-progress" aria-hidden="true">
																			<span></span>
																		</div>
																		<div class="preview-code-actions">
																			<button class="preview-auth-button secondary" type="button">
																				<span class="i-ph-arrow-left"></span>
																				{t('戻る', 'Back')}
																			</button>
																			<button class="preview-auth-button secondary" type="button">
																				<span class="i-ph-arrow-clockwise"></span>
																				{t('再送信', 'Resend')}
																			</button>
																		</div>
																	{:else}
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-arrow-left"></span>
																			{t('戻る', 'Back')}
																		</button>
																	{/if}
																	<button class="preview-auth-button" type="button">
																		<span class="i-ph-check-circle"></span>
																		{t('確認', 'Verify')}
																	</button>
																</div>
															{:else if blockType === 'consent_widget'}
																<div class="preview-consent-widget">
																	<div class="preview-consent-widget__heading">
																		<span class="i-ph-handshake"></span>
																		<strong
																			>{field.label ||
																				t('同意確認', 'Consent confirmation')}</strong
																		>
																	</div>
																	<p>
																		{field.text ||
																			t(
																				'Flowの同意ポリシーとDestination Profileの項目がここに表示されます。',
																				'The Flow consent policy and Destination Profile fields are rendered here.'
																			)}
																	</p>
																	<label class="preview-check-field">
																		<input type="checkbox" disabled />
																		<span
																			>{t(
																				'内容を確認しました',
																				'I have reviewed the consent items'
																			)}</span
																		>
																	</label>
																</div>
															{:else if isAccountWidgetType(blockType)}
																{@const part = accountWidgetPart(blockType)}
																<div class="preview-account-widget">
																	<span class={part?.icon ?? 'i-ph-squares-four'}></span>
																	<div>
																		<strong
																			>{field.label ||
																				(part ? t(part.labelJa, part.labelEn) : '')}</strong
																		>
																	</div>
																</div>
															{:else if blockType === 'heading'}
																<div class="preview-heading-block">
																	<h2>{field.label}</h2>
																	{#if field.text}
																		<p>{field.text}</p>
																	{/if}
																</div>
															{:else if blockType === 'text'}
																<p class="preview-static-text">{field.text || field.label}</p>
															{:else if blockType === 'link'}
																<a class="preview-static-link" href={safePreviewHref(field.href)}
																	>{field.label}</a
																>
															{:else if blockType === 'security_verification'}
																<div class="preview-security-box">
																	<span class="i-ph-shield-check"></span>
																	<span>
																		{field.text || field.label}
																		<small
																			>{humanVerificationTimingLabel(
																				field.human_verification_timing
																			)}</small
																		>
																	</span>
																</div>
															{:else if blockType === 'divider'}
																<div
																	class="preview-divider"
																	class:has-label={Boolean(dividerLabel(field))}
																>
																	<span>{dividerLabel(field)}</span>
																</div>
															{/if}
														</div>
													{/each}
												</div>
											{/if}
										{/each}
									{/if}
								</div>
							{:else}
								<div class="localization-panel" id="screen-editor-localization">
									<p class="muted">
										{t(
											'項目ごとの表示名を言語別に設定します。内部IDは自動採番され、ローカライズ値の紐付けに使います。',
											'Set per-language labels for each item. Internal IDs are generated automatically and used as localization keys.'
										)}
									</p>
									<AdminDataTable width="wide">
										<thead>
											<tr>
												<th>{t('項目名', 'Item')}</th>
												<th>{t('内部ID', 'Internal ID')}</th>
												{#each localizationLanguages as language (language.code)}
													<th>{t(language.labelJa, language.labelEn)}</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each localizableDraftBlocks as field, index (blockKey(field, index))}
												<tr>
													<td>
														<strong>{blockTitle(field)}</strong>
														<small>{blockSubtitle(field)}</small>
													</td>
													<td><code>{localizationKey(field, index)}</code></td>
													{#each localizationLanguages as language (language.code)}
														<td>
															<input
																value={localizedFieldLabel(field, language.code, index)}
																placeholder={localizedFieldPlaceholder(field, language.code, index)}
																oninput={(event) =>
																	updateLocalizationLabel(
																		field,
																		language.code,
																		event.currentTarget.value,
																		index
																	)}
															/>
														</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</AdminDataTable>
								</div>
							{/if}

							<div class="actions">
								{#if draft.settings.base_preset_key}
									<button
										class="btn-secondary"
										type="button"
										onclick={resetScreenPreset}
										disabled={saving}
									>
										{t('プリセットに戻す', 'Reset preset')}
									</button>
								{/if}
								<button
									class="btn-danger"
									type="button"
									onclick={deleteScreen}
									disabled={saving || !draft.id || draft.is_system}
								>
									{$LL.admin_screens_delete()}
								</button>
								<div class="actions-right">
									<button
										class="btn-secondary"
										type="button"
										onclick={() => {
											if (selectedScreen) selectScreen(selectedScreen);
											else viewMode = 'preview';
										}}
										disabled={saving}
									>
										{$LL.admin_screens_cancel()}
									</button>
									<button class="btn-primary" type="button" onclick={saveProfile} disabled={saving}>
										{saving ? $LL.admin_screens_saving() : $LL.admin_screens_save()}
									</button>
								</div>
							</div>
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	.alert {
		margin-bottom: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}
	.alert.error {
		border-color: var(--color-danger, #dc2626);
		color: var(--color-danger, #dc2626);
	}
	.alert.success {
		border-color: var(--color-success, #16a34a);
		color: var(--color-success, #16a34a);
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
		gap: 1rem;
	}
	.layout.editing {
		grid-template-columns: minmax(0, 1fr);
	}
	.screen-list {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.5rem;
	}
	.screen-row {
		display: grid;
		width: 100%;
		gap: 0.2rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		padding: 0.65rem 0.75rem;
		text-align: left;
	}
	.screen-row.active,
	.screen-row:hover {
		background: var(--color-surface-muted);
	}
	.screen-row small,
	.muted,
	.note {
		color: var(--color-text-muted);
	}
	.required-fields-warning {
		display: grid;
		gap: 0.85rem;
		border: 1px solid color-mix(in srgb, var(--color-warning, #d59a2e) 58%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-warning, #d59a2e) 8%, var(--color-surface));
		padding: 1rem;
	}
	.required-fields-warning__heading,
	.required-fields-warning__item,
	.required-fields-warning__footer,
	.required-fields-warning__actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.required-fields-warning__heading {
		align-items: flex-start;
	}
	.required-fields-warning__heading > span {
		flex: 0 0 auto;
		margin-top: 0.15rem;
		color: var(--color-warning, #b7791f);
		font-size: 1.25rem;
	}
	.required-fields-warning p {
		margin: 0.2rem 0 0;
		color: var(--color-text-muted);
		line-height: 1.5;
	}
	.required-fields-warning__list {
		display: grid;
		gap: 0.55rem;
	}
	.required-fields-warning__item {
		justify-content: space-between;
		border-top: 1px solid var(--color-border);
		padding-top: 0.55rem;
	}
	.required-fields-warning__item > div:first-child {
		display: grid;
		gap: 0.15rem;
	}
	.required-fields-warning__item code {
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}
	.required-fields-warning__footer {
		justify-content: space-between;
		align-items: flex-end;
	}
	.required-fields-warning .compact {
		min-height: 2.1rem;
		padding: 0.4rem 0.65rem;
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.inspector-note {
		margin: -0.25rem 0 0;
		font-size: 0.8rem;
		line-height: 1.45;
	}
	.detail-panel,
	.editor {
		display: grid;
		gap: 1rem;
		align-content: start;
	}
	.editor-head,
	.fields-head,
	.actions,
	.preview-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2,
	h3 {
		margin: 0;
	}
	.preview-head {
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 1rem;
	}
	.preview-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.preview-meta span {
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.15rem 0.5rem;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}
	.screen-preview {
		display: grid;
		gap: 1.15rem;
		width: min(100%, 420px);
		max-width: 420px;
		border: 1px solid var(--color-border);
		border-radius: 24px;
		background: var(--color-surface);
		padding: 2.75rem 2rem;
	}
	.screen-preview.wide-canvas {
		width: min(100%, 760px);
		max-width: 760px;
	}
	.preview-layout-row {
		display: grid;
		gap: 1.15rem;
		align-items: start;
	}
	.preview-layout-cell {
		min-width: 0;
	}
	.preview-field {
		display: grid;
		gap: 0.55rem;
	}
	.preview-field > span {
		font-weight: 700;
	}
	.preview-field strong {
		margin-left: 0.35rem;
		color: var(--color-danger, #dc2626);
		font-size: 0.78rem;
	}
	.preview-field small {
		color: var(--color-text-muted);
		font-weight: 400;
	}
	.preview-field input[readonly] {
		min-height: 46px;
		border-radius: 12px;
		opacity: 0.86;
	}
	.preview-check-field {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface-muted);
		padding: 0.55rem 0.7rem;
		font-weight: 500;
	}
	.preview-check-field input {
		width: auto;
	}
	.preview-auth-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-primary);
		color: var(--button-primary-color, var(--text-inverse, var(--color-accent-contrast, #fff)));
		padding: 0.8rem 1rem;
		font: inherit;
		font-weight: 700;
	}
	.preview-auth-button.secondary {
		background: var(--color-surface-muted);
		color: inherit;
	}
	.preview-auth-widget {
		display: grid;
		gap: 0.75rem;
	}
	.preview-account-widget {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		min-height: 5rem;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-surface-muted);
		padding: 1rem;
	}
	.preview-account-widget > span {
		font-size: 1.5rem;
		color: var(--color-primary);
	}
	.preview-account-widget div {
		display: grid;
		gap: 0.25rem;
	}
	.screen-preview-toolbar {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.screen-preview-toolbar select {
		min-width: 0;
	}
	.screen-preview.mobile-preview {
		max-width: 24rem;
		margin-inline: auto;
	}
	.screen-preview.mobile-preview .preview-layout-row {
		grid-template-columns: 1fr !important;
	}
	.preview-code-input-widget {
		display: grid;
		gap: 0.75rem;
	}
	.preview-code-progress {
		height: 0.45rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
	}
	.preview-code-progress span {
		display: block;
		width: 62%;
		height: 100%;
		border-radius: inherit;
		background: var(--color-primary);
	}
	.preview-code-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.preview-consent-widget {
		display: grid;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-surface-muted);
		padding: 0.9rem;
	}
	.preview-consent-widget__heading {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 700;
	}
	.preview-consent-widget__heading span {
		color: var(--color-primary);
	}
	.preview-consent-widget p {
		margin: 0;
		color: var(--color-text-muted);
		line-height: 1.5;
	}
	.preview-heading-block {
		display: grid;
		gap: 0.35rem;
	}
	.preview-heading-block h2 {
		margin: 0;
		color: var(--color-heading, var(--color-text));
		font-size: 1.45rem;
		line-height: 1.2;
	}
	.preview-heading-block p {
		margin: 0;
		color: var(--color-text-muted);
		line-height: 1.5;
	}
	.preview-static-text {
		margin: 0;
		color: var(--color-text);
		font-weight: 600;
		line-height: 1.55;
		white-space: pre-line;
	}
	.preview-security-box {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-surface-muted);
		padding: 0.85rem 1rem;
		color: var(--color-text-muted);
		font-weight: 600;
	}
	.preview-security-box > span:first-child {
		color: var(--color-primary);
	}
	.preview-security-box small {
		display: block;
		margin-top: 0.2rem;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 500;
	}
	.preview-divider {
		display: grid;
		grid-template-columns: 1fr;
		align-items: center;
		width: 100%;
		color: var(--color-text-muted);
		margin: 0.25rem 0;
	}
	.preview-divider::before {
		content: '';
		display: block;
		border-top: 1px solid var(--color-border);
	}
	.preview-divider.has-label {
		grid-template-columns: minmax(40px, 1fr) auto minmax(40px, 1fr);
		gap: 0.75rem;
	}
	.preview-divider.has-label::after {
		content: '';
		display: block;
		border-top: 1px solid var(--color-border);
	}
	.preview-divider span {
		display: none;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.preview-divider.has-label span {
		display: inline;
	}
	.draft-preview:not(.wide-canvas) {
		max-width: 720px;
	}
	.localization-panel {
		display: grid;
		gap: 0.75rem;
	}
	.localization-panel p {
		margin: 0;
	}
	.localization-panel :global(table) {
		min-width: 760px;
	}
	.localization-panel :global(th),
	.localization-panel :global(td) {
		vertical-align: top;
	}
	.localization-panel :global(td:first-child) {
		display: grid;
		gap: 0.2rem;
		min-width: 180px;
	}
	.localization-panel :global(td:first-child small) {
		color: var(--color-text-muted);
	}
	.localization-panel :global(code) {
		display: inline-block;
		max-width: 220px;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-surface-muted);
		padding: 0.15rem 0.35rem;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.localization-panel :global(input) {
		width: 100%;
		min-width: 180px;
	}
	.empty-detail {
		display: grid;
		justify-items: start;
		gap: 0.75rem;
		border: 1px dashed var(--color-border);
		border-radius: 8px;
		padding: 1.5rem;
	}
	label {
		display: grid;
		gap: 0.35rem;
		font-weight: 600;
	}
	input,
	select,
	textarea {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: inherit;
		padding: 0.55rem 0.7rem;
		font: inherit;
		font-weight: 400;
	}
	.grid.two {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.tab-panel-head {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 1rem;
	}
	.tab-panel-head p {
		margin: 0;
	}
	.screen-builder {
		display: grid;
		grid-template-columns: minmax(180px, 240px) minmax(320px, 1fr) minmax(220px, 300px);
		gap: 1rem;
		align-items: start;
	}
	.parts-panel,
	.builder-canvas,
	.inspector-panel {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		padding: 0.75rem;
	}
	.parts-panel,
	.inspector-panel {
		display: grid;
		gap: 0.75rem;
	}
	.part-card {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.25rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: transparent;
		color: inherit;
		padding: 0.75rem;
		text-align: left;
		cursor: grab;
	}
	.part-card:hover {
		background: var(--color-surface-muted);
	}
	.part-card > span {
		grid-row: span 2;
		margin-top: 0.15rem;
		color: var(--color-primary);
	}
	.part-card small {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.builder-canvas {
		display: grid;
		gap: 0.45rem;
		min-height: 360px;
		align-content: start;
	}
	.builder-layout-row {
		display: grid;
		gap: 0.75rem;
		border: 1px solid transparent;
		border-radius: 10px;
	}
	.builder-layout-row.has-columns {
		border-color: var(--color-border);
		background: color-mix(in srgb, var(--color-surface-muted) 35%, transparent);
		padding: 0.55rem;
	}
	.builder-layout-column {
		display: grid;
		align-content: start;
		gap: 0.45rem;
		min-width: 0;
		min-height: 7rem;
		border: 1px dashed transparent;
		border-radius: 8px;
		padding: 0.35rem;
	}
	.builder-layout-row.has-columns .builder-layout-column {
		border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
		background: color-mix(in srgb, var(--color-surface) 72%, transparent);
	}
	.builder-layout-column.empty {
		place-content: stretch;
	}
	.builder-column-label {
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: uppercase;
	}
	.drop-zone {
		display: grid;
		min-height: 0.7rem;
		place-items: center;
		border: 1px dashed transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--color-primary);
		font: inherit;
		font-size: 0.78rem;
	}
	.drop-zone.active,
	.drop-zone:hover {
		min-height: 2rem;
		border-color: var(--color-primary);
		background: var(--color-surface-muted);
	}
	.drop-zone.final {
		min-height: 3rem;
		border-color: var(--color-border);
		color: var(--color-text-muted);
	}
	.drop-zone.column-drop {
		min-height: 2.6rem;
	}
	.canvas-block {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		padding: 0.7rem;
	}
	.drag-handle {
		display: grid;
		flex: 0 0 auto;
		width: 1.65rem;
		height: 2.15rem;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-muted);
		cursor: grab;
	}
	.drag-handle:hover,
	.drag-handle:focus-visible {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}
	.drag-handle span {
		width: 0.72rem;
		height: 1.05rem;
		background-image: radial-gradient(currentColor 1.35px, transparent 1.35px);
		background-size: 0.36rem 0.36rem;
		opacity: 0.9;
	}
	.block-select {
		display: grid;
		min-width: 0;
		flex: 1;
		border: 0;
		background: transparent;
		color: inherit;
		padding: 0;
		font: inherit;
		text-align: left;
	}
	.canvas-block.active {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);
	}
	.canvas-block.layout-block {
		border-style: dashed;
		background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface));
	}
	.block-main {
		display: grid;
		min-width: 0;
		gap: 0.2rem;
	}
	.block-main small {
		overflow: hidden;
		color: var(--color-text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.block-actions {
		display: inline-flex;
		flex-shrink: 0;
		gap: 0.35rem;
	}
	.icon-button.danger {
		color: var(--color-danger, #dc2626);
	}
	.inspector-panel {
		font-size: 0.9rem;
	}
	.inspector-panel h3 {
		margin-bottom: 0.25rem;
		font-size: 0.95rem;
	}
	.inspector-panel label {
		gap: 0.3rem;
	}
	.inspector-panel label > span {
		font-size: 0.84rem;
	}
	.inspector-panel input,
	.inspector-panel select,
	.inspector-panel textarea {
		padding: 0.48rem 0.6rem;
		font-size: 0.86rem;
	}
	.inspector-panel select {
		min-height: 2.2rem;
		font-size: 0.84rem;
	}
	.check,
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 500;
	}
	.check input,
	.toggle input {
		width: auto;
	}
	.canvas-layout-select {
		max-width: 20rem;
	}
	.selected-methods {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.method-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-surface-muted);
		color: inherit;
		padding: 0.35rem 0.55rem;
		font: inherit;
		font-size: 0.82rem;
		font-weight: 650;
	}
	.actions-right {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
	}
	.icon-button {
		display: inline-grid;
		width: 2.4rem;
		height: 2.4rem;
		place-items: center;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: transparent;
		color: inherit;
	}
	.btn-primary,
	.btn-secondary,
	.btn-danger,
	.btn-edit {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.55rem 0.8rem;
		font: inherit;
		font-weight: 600;
	}
	.btn-primary {
		background: var(--color-primary);
		color: var(--button-primary-color, var(--text-inverse, var(--color-accent-contrast, #fff)));
	}
	.btn-secondary {
		background: var(--color-surface);
		color: inherit;
	}
	.btn-edit {
		background: var(--color-surface);
		color: var(--color-text);
		box-shadow: none;
	}
	.btn-edit:hover {
		background: var(--color-surface-muted);
	}
	.btn-danger {
		border-color: var(--color-danger, #dc2626);
		background: transparent;
		color: var(--color-danger, #dc2626);
	}
	@media (max-width: 900px) {
		.layout,
		.grid.two,
		.screen-builder {
			grid-template-columns: 1fr;
		}
		.preview-layout-row {
			grid-template-columns: 1fr !important;
		}
		.required-fields-warning__item,
		.required-fields-warning__footer {
			align-items: stretch;
			flex-direction: column;
		}
		.required-fields-warning__actions {
			flex-wrap: wrap;
		}
	}
</style>
