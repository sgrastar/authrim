<script lang="ts">
	import { onMount } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import {
		adminCustomClaimsAPI,
		type CustomClaimSchema,
		type FieldType
	} from '$lib/api/admin-custom-claims';
	import {
		adminFormProfilesAPI,
		type FormProfile,
		type FormProfileBlockType,
		type FormProfileCanvasLayout,
		type FormProfileField,
		type FormProfileKind,
		type FormProfileLocalization,
		type FormProfileSettings,
		type FormProfileValueType
	} from '$lib/api/admin-form-profiles';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminTabs,
		type AdminTabItem
	} from '$lib/components/admin';

	type Draft = {
		id: string | null;
		profile_key: string;
		display_name: string;
		description: string;
		form_kind: FormProfileKind;
		fields: FormProfileField[];
		localizations: Record<string, FormProfileLocalization>;
		settings: FormProfileSettings;
		is_active: boolean;
		is_system: boolean;
	};

	type FormPart = {
		type: FormProfileBlockType;
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

	type FormEditorTab = 'items' | 'preview' | 'localization';
	type IdentitySchemaOption = {
		field: string;
		label: string;
		valueType: FormProfileValueType;
		source: 'system' | 'custom';
	};
	type LayoutSection = {
		id: string;
		columns: number;
		row?: { field: FormProfileField; index: number };
		items: Array<{ field: FormProfileField; index: number }>;
	};

	const kindOptions: FormProfileKind[] = [
		'registration',
		'profile_completion',
		'login',
		'consent',
		'custom'
	];
	const formParts: FormPart[] = [
		{
			type: 'layout_row',
			labelJa: 'レイアウト行',
			labelEn: 'Layout row',
			descriptionJa: '1カラム/2カラムの行を追加し、フォームの段組みを切り替えます。',
			descriptionEn: 'Add a one- or two-column row to control the form layout.',
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
			type: 'consent_widget',
			labelJa: '同意ウィジェット',
			labelEn: 'Consent widget',
			descriptionJa: 'Flowで選択した同意ポリシーを表示し、回答を取得する枠です。',
			descriptionEn: 'Render the consent policy selected on the Flow node and collect answers.',
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
			descriptionJa: 'フォーム内の区切りを配置します。',
			descriptionEn: 'Add a visual divider.',
			icon: 'i-ph-line-segment'
		}
	];
	const authMethodOptions: AuthMethodOption[] = [
		{ value: 'passkey', label: 'Passkey' },
		{ value: 'mail_otp', label: 'Mail OTP' },
		{ value: 'external_idp', label: 'Ext. IdP' },
		{ value: 'directory_password', label: 'Directory Password' }
	];
	const localizationLanguages = [
		{ code: 'en', labelJa: '英語', labelEn: 'English' },
		{ code: 'ja', labelJa: '日本語', labelEn: 'Japanese' }
	];
	const fallbackIdentitySchemaOptions: IdentitySchemaOption[] = [
		{ field: 'email', label: 'Email', valueType: 'text', source: 'system' },
		{ field: 'name', label: 'Name', valueType: 'text', source: 'system' },
		{ field: 'given_name', label: 'Given name', valueType: 'text', source: 'system' },
		{ field: 'family_name', label: 'Family name', valueType: 'text', source: 'system' },
		{
			field: 'preferred_username',
			label: 'Preferred username',
			valueType: 'text',
			source: 'system'
		}
	];

	let profiles = $state<FormProfile[]>([]);
	let identitySchemaOptions = $state<IdentitySchemaOption[]>(fallbackIdentitySchemaOptions);
	let selectedId = $state<string | null>(null);
	let viewMode = $state<'preview' | 'edit'>('preview');
	let editorTab = $state<FormEditorTab>('items');
	let draft = $state<Draft>(createEmptyDraft());
	let selectedBlockIndex = $state(0);
	let draggedPartType = $state<FormProfileBlockType | null>(null);
	let draggedBlockIndex = $state<number | null>(null);
	let dropTargetIndex = $state<number | null>(null);
	let dropTargetColumn = $state<number | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let message = $state('');

	const selectedProfile = $derived(profiles.find((profile) => profile.id === selectedId) ?? null);
	const previewFields = $derived(
		selectedProfile
			? [...selectedProfile.fields].sort(
					(a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
				)
			: []
	);
	const orderedDraftBlocks = $derived(
		[...draft.fields].sort(
			(a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
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
			panelId: 'form-editor-items'
		},
		{
			id: 'preview',
			label: t('プレビュー', 'Preview'),
			icon: 'i-ph-eye',
			panelId: 'form-editor-preview'
		},
		{
			id: 'localization',
			label: t('ローカライゼーション', 'Localization'),
			icon: 'i-ph-translate',
			panelId: 'form-editor-localization'
		}
	]);

	onMount(() => {
		void loadProfiles();
		void loadIdentitySchemaOptions();
	});

	function createEmptyDraft(): Draft {
		return {
			id: null,
			profile_key: '',
			display_name: '',
			description: '',
			form_kind: 'registration',
			fields: [
				createBlock('auth_widget', 10),
				createBlock('identity_field', 20, { field: 'email', label: 'Email', required: true })
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

	function createBlockId(type: FormProfileBlockType): string {
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

	function createStableBlockId(field: FormProfileField, index: number): string {
		return normalizeInternalId(`${getBlockType(field)}-${field.field || 'block'}-${index + 1}`);
	}

	function getBlockType(block: FormProfileField): FormProfileBlockType {
		return block.block_type ?? 'identity_field';
	}

	function normalizeValueType(value: unknown): FormProfileValueType {
		return value === 'boolean' ? 'boolean' : 'text';
	}

	function normalizeCanvasLayout(value: unknown): FormProfileCanvasLayout {
		return value === 'wide' ? 'wide' : 'narrow';
	}

	function normalizeSettings(
		settings: FormProfileSettings | null | undefined
	): FormProfileSettings {
		return {
			canvas_layout: normalizeCanvasLayout(settings?.canvas_layout)
		};
	}

	function normalizeAuthMethod(value: unknown): string {
		if (typeof value === 'string' && authMethodOption(value)) return value;
		return 'passkey';
	}

	function authMethodOption(value: string): AuthMethodOption | null {
		return authMethodOptions.find((option) => option.value === value) ?? null;
	}

	function selectedAuthWidgetMethod(block: FormProfileField | null): string {
		if (!block) return 'passkey';
		return normalizeAuthMethod(block.auth_method);
	}

	function updateAuthWidgetMethod(method: string) {
		if (!method || !authMethodOption(method)) return;
		updateField(selectedBlockIndex, {
			auth_method: method,
			field: `auth.${method}`,
			label: authWidgetDefaultLabel(method)
		});
	}

	function authWidgetDefaultLabel(method: string): string {
		switch (method) {
			case 'mail_otp':
				return t('認証コードを送信', 'Send verification code');
			case 'external_idp':
				return t('Ext. IdPでログイン', 'Sign in with Ext. IdP');
			case 'directory_password':
				return t('ログイン', 'Sign in');
			case 'passkey':
			default:
				return t('Passkeyでサインイン', 'Sign in with Passkey');
		}
	}

	function valueTypeFromSchemaFieldType(fieldType: FieldType): FormProfileValueType {
		return fieldType === 'boolean' ? 'boolean' : 'text';
	}

	function selectedSchemaOption(field: string | undefined): IdentitySchemaOption | null {
		return identitySchemaOptions.find((option) => option.field === field) ?? null;
	}

	function normalizeIdentitySchemaOptions(schemas: CustomClaimSchema[]): IdentitySchemaOption[] {
		const options = new Map<string, IdentitySchemaOption>();
		for (const option of fallbackIdentitySchemaOptions) {
			options.set(option.field, option);
		}
		for (const schema of schemas) {
			if (schema.is_active !== 1) continue;
			options.set(schema.field_key, {
				field: schema.field_key,
				label: schema.display_label || schema.field_key,
				valueType: valueTypeFromSchemaFieldType(schema.field_type),
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

	function buildLayoutSections(fields: FormProfileField[]): LayoutSection[] {
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
		return sections.filter((section, index) => index === 0 || section.row || section.items.length > 0);
	}

	function previewGridColumn(field: FormProfileField, columns: number): string | undefined {
		const column = readLayoutColumn(field.layout_column);
		if (!column || columns < 2) return undefined;
		return `${Math.min(column, columns)} / span 1`;
	}

	function displayColumnForItem(
		field: FormProfileField,
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
			(item, position) =>
				displayColumnForItem(item.field, position, section.columns) === column
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
			value_type: option?.valueType ?? 'text'
		});
	}

	function createBlock(
		type: FormProfileBlockType,
		order: number,
		patch: Partial<FormProfileField> = {}
	): FormProfileField {
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
				auth_method: method
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
						'Flowノードで選択した同意ポリシーをここに表示します。',
						'The consent policy selected on the Flow node is rendered here.'
					),
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
		if (type === 'security_verification') {
			return {
				field: patch.field ?? `security.${blockId}`,
				label: patch.label ?? t('セキュリティ確認', 'Security check'),
				required: false,
				block_type: type,
				block_id: blockId,
				text: patch.text ?? t('私は人間です', 'I am human'),
				order,
				...patch
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

	function normalizeBlocks(fields: FormProfileField[]): FormProfileField[] {
		const source =
			fields.length > 0
				? fields
				: [createBlock('identity_field', 10, { field: 'email', label: 'Email' })];
		const seen = new Set<string>();
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
					block_id: blockId
				});
			})
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}

	function blockTitle(block: FormProfileField): string {
		const type = getBlockType(block);
		if (type === 'identity_field') return block.label || block.field;
		if (type === 'auth_widget')
			return block.label || authWidgetDefaultLabel(selectedAuthWidgetMethod(block));
		if (type === 'consent_widget') return block.label || t('同意確認', 'Consent confirmation');
		if (type === 'heading') return block.label || t('見出し', 'Heading');
		if (type === 'text') return block.label || 'Text';
		if (type === 'security_verification')
			return block.label || t('セキュリティ確認', 'Security check');
		if (type === 'layout_row') return block.label || 'Layout row';
		return block.label || 'Divider';
	}

	function blockSubtitle(block: FormProfileField): string {
		const type = getBlockType(block);
		if (type === 'identity_field')
			return `${block.field} / ${normalizeValueType(block.value_type)}`;
		if (type === 'auth_widget') return authMethodLabel(selectedAuthWidgetMethod(block));
		if (type === 'consent_widget') return block.text ?? t('同意ポリシー', 'Consent policy');
		if (type === 'heading') return block.text ?? '';
		if (type === 'text') return block.text ?? '';
		if (type === 'security_verification') return block.text ?? '';
		if (type === 'layout_row') {
			const columns = readLayoutColumns(block.layout_columns);
			return columns === 1 ? t('1カラム', '1 column') : t('2カラム', '2 columns');
		}
		return dividerLabel(block) || t('区切り線', 'Divider');
	}

	function dividerLabel(field: FormProfileField): string {
		if (field.label && field.label !== 'Divider') return field.label;
		return field.text ?? '';
	}

	function blockKey(block: FormProfileField, index: number): string {
		return block.block_id ?? `${block.field}-${index}`;
	}

	function localizationKey(block: FormProfileField, index = 0): string {
		return block.block_id ?? blockKey(block, index);
	}

	function localizedFieldLabel(block: FormProfileField, language: string, index = 0): string {
		const key = localizationKey(block, index);
		return draft.localizations[language]?.fields?.[key]?.label ?? '';
	}

	function updateLocalizationLabel(
		block: FormProfileField,
		language: string,
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
		localizations: Record<string, FormProfileLocalization>,
		fields: FormProfileField[]
	): Record<string, FormProfileLocalization> {
		const allowedKeys = new Set(fields.map((field, index) => localizationKey(field, index)));
		const next: Record<string, FormProfileLocalization> = {};
		for (const [language, localization] of Object.entries(localizations)) {
			const localizedFields: NonNullable<FormProfileLocalization['fields']> = {};
			for (const [fieldKey, fieldLocalization] of Object.entries(localization.fields ?? {})) {
				if (!allowedKeys.has(fieldKey)) continue;
				const label = fieldLocalization.label?.trim();
				const helpText = fieldLocalization.help_text?.trim();
				const placeholder = fieldLocalization.placeholder?.trim();
				if (!label && !helpText && !placeholder) continue;
				localizedFields[fieldKey] = {
					...(label ? { label } : {}),
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

	function authMethodLabel(value: string | null | undefined): string {
		return authMethodOptions.find((option) => option.value === value)?.label ?? value ?? 'Passkey';
	}

	function toBoolean(value: boolean | number): boolean {
		return value === true || value === 1;
	}

	function kindLabel(kind: FormProfileKind): string {
		switch (kind) {
			case 'registration':
				return $LL.admin_forms_kind_registration();
			case 'profile_completion':
				return $LL.admin_forms_kind_profile_completion();
			case 'login':
				return $LL.admin_forms_kind_login();
			case 'consent':
				return t('同意', 'Consent');
			case 'custom':
			default:
				return $LL.admin_forms_kind_custom();
		}
	}

	function selectProfile(profile: FormProfile) {
		selectedId = profile.id;
		viewMode = 'preview';
		draft = {
			id: profile.id,
			profile_key: profile.profile_key,
			display_name: profile.display_name,
			description: profile.description ?? '',
			form_kind: profile.form_kind,
			fields: normalizeBlocks(profile.fields),
			localizations: profile.localizations ?? {},
			settings: normalizeSettings(profile.settings),
			is_active: toBoolean(profile.is_active),
			is_system: toBoolean(profile.is_system)
		};
		selectedBlockIndex = 0;
	}

	function newProfile() {
		selectedId = null;
		viewMode = 'edit';
		editorTab = 'items';
		draft = createEmptyDraft();
		selectedBlockIndex = 0;
		message = '';
		error = '';
	}

	function editProfile() {
		if (!selectedProfile) return;
		selectProfile(selectedProfile);
		viewMode = 'edit';
		editorTab = 'items';
	}

	async function loadProfiles() {
		loading = true;
		error = '';
		try {
			const response = await adminFormProfilesAPI.list();
			profiles = response.profiles;
			if (!selectedId && profiles.length > 0) selectProfile(profiles[0]);
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : $LL.admin_forms_load_failed();
		} finally {
			loading = false;
		}
	}

	function removeField(index: number) {
		draft.fields = draft.fields.filter((_, fieldIndex) => fieldIndex !== index);
		selectedBlockIndex = Math.max(0, Math.min(selectedBlockIndex, draft.fields.length - 1));
	}

	function updateField(index: number, patch: Partial<FormProfileField>) {
		draft.fields = draft.fields.map((field, fieldIndex) =>
			fieldIndex === index ? { ...field, ...patch } : field
		);
	}

	function normalizeOrders(fields: FormProfileField[]): FormProfileField[] {
		return fields.map((field, index) => ({ ...field, order: (index + 1) * 10 }));
	}

	function addBlock(
		type: FormProfileBlockType,
		atIndex = draft.fields.length,
		patch: Partial<FormProfileField> = {}
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
							value_type: firstSchema.valueType
						}
					: {}),
				...patch
			})
		);
		draft.fields = normalizeOrders(next);
		selectedBlockIndex = atIndex;
		editorTab = 'items';
	}

	function moveBlock(
		fromIndex: number,
		toIndex: number,
		patch: Partial<FormProfileField> = {}
	) {
		const next = [...orderedDraftBlocks];
		if (fromIndex < 0 || fromIndex >= next.length) return;
		const [item] = next.splice(fromIndex, 1);
		next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, { ...item, ...patch });
		draft.fields = normalizeOrders(next);
		selectedBlockIndex = Math.max(0, Math.min(toIndex, next.length - 1));
	}

	function handlePartDragStart(event: DragEvent, type: FormProfileBlockType) {
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
			addBlock(
				draggedPartType,
				index,
				draggedPartType === 'layout_row' ? {} : layoutColumnPatch
			);
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
				profile_key: draft.profile_key,
				display_name: draft.display_name,
				description: draft.description || null,
				form_kind: draft.form_kind,
				fields: orderedDraftBlocks.map((field, index) => ({
					...field,
					block_id: localizationKey(field, index),
					order: (index + 1) * 10
				})),
				localizations: sanitizeLocalizationsForSave(draft.localizations, orderedDraftBlocks),
				settings: normalizeSettings(draft.settings),
				is_active: draft.is_active
			};
			if (draft.id) {
				await adminFormProfilesAPI.update(draft.id, body);
			} else {
				const response = await adminFormProfilesAPI.create(body);
				selectedId = response.profile.id;
			}
			message = $LL.admin_forms_saved();
			await loadProfiles();
			const next = profiles.find((profile) => profile.id === selectedId);
			if (next) selectProfile(next);
			viewMode = 'preview';
		} catch (saveError) {
			error = saveError instanceof Error ? saveError.message : $LL.admin_forms_save_failed();
		} finally {
			saving = false;
		}
	}

	async function deleteProfile() {
		if (!draft.id || draft.is_system) return;
		if (!confirm($LL.admin_forms_delete_confirm())) return;
		saving = true;
		error = '';
		message = '';
		try {
			await adminFormProfilesAPI.delete(draft.id);
			selectedId = null;
			viewMode = 'preview';
			draft = createEmptyDraft();
			message = $LL.admin_forms_deleted();
			await loadProfiles();
		} catch (deleteError) {
			error = deleteError instanceof Error ? deleteError.message : $LL.admin_forms_delete_failed();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_forms_page_title()}</title>
</svelte:head>

{#snippet canvasBlock(field: FormProfileField, index: number)}
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
		<button
			type="button"
			class="block-select"
			onclick={() => (selectedBlockIndex = index)}
		>
			<span class="block-main">
				<strong>{blockTitle(field)}</strong>
				<small>{blockSubtitle(field)}</small>
			</span>
		</button>
		<div class="block-actions">
			<button
				type="button"
				class="icon-button danger"
				aria-label={$LL.admin_forms_remove_field()}
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
	<AdminPageHeader title={$LL.admin_forms_title()} description={$LL.admin_forms_description()}>
		{#snippet actions()}
			<button class="btn-secondary" type="button" onclick={newProfile}>
				<span class="i-ph-plus"></span>
				{$LL.admin_forms_create()}
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
			<p class="muted">{$LL.admin_forms_loading()}</p>
		{:else}
			<div class:editing={viewMode === 'edit'} class="layout">
				{#if viewMode === 'preview'}
					<aside class="profile-list" aria-label={$LL.admin_forms_title()}>
						{#if profiles.length === 0}
							<p class="muted">{$LL.admin_forms_empty()}</p>
						{:else}
							{#each profiles as profile (profile.id)}
								<button
									type="button"
									class:active={selectedProfile?.id === profile.id}
									class="profile-row"
									onclick={() => selectProfile(profile)}
								>
									<span>{kindLabel(profile.form_kind)}</span>
									<small>{profile.display_name}</small>
								</button>
							{/each}
						{/if}
					</aside>
				{/if}

				<section class="detail-panel" aria-label={$LL.admin_forms_select_profile()}>
					{#if viewMode === 'preview'}
						{#if selectedProfile}
							<div class="preview-head">
								<div>
									<h2>{selectedProfile.display_name}</h2>
									<div class="preview-meta">
										<span>{kindLabel(selectedProfile.form_kind)}</span>
										<span>{selectedProfile.profile_key}</span>
										{#if toBoolean(selectedProfile.is_system)}
											<span>{$LL.admin_forms_system()}</span>
										{/if}
										{#if toBoolean(selectedProfile.is_active)}
											<span>{$LL.admin_forms_active()}</span>
										{/if}
									</div>
								</div>
								<button class="btn-edit" type="button" onclick={editProfile}>
									<span class="i-ph-pencil-simple"></span>
									{$LL.admin_forms_edit()}
								</button>
							</div>

							<div
								class:wide-canvas={normalizeSettings(selectedProfile.settings).canvas_layout ===
									'wide'}
								class="form-preview"
								aria-label={$LL.admin_forms_preview()}
							>
								{#if previewLayoutSections.every((section) => section.items.length === 0)}
									<p class="muted">{$LL.admin_forms_no_fields()}</p>
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
																		<strong>{$LL.admin_forms_required_mark()}</strong>
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
																	<div class="preview-field">
																		<span>{t('メールアドレス', 'Email address')}</span>
																		<input readonly placeholder="you@example.com" />
																	</div>
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-envelope-simple"></span>
																		{field.label || authWidgetDefaultLabel(method)}
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
																		{field.label || authWidgetDefaultLabel(method)}
																	</button>
																{:else if method === 'external_idp'}
																	<button class="preview-auth-button secondary" type="button">
																		<span class="i-ph-globe"></span>
																		{field.label || authWidgetDefaultLabel(method)}
																	</button>
																{:else}
																	<button class="preview-auth-button" type="button">
																		<span class="i-ph-key"></span>
																		{field.label || authWidgetDefaultLabel(method)}
																	</button>
																{/if}
															</div>
														{:else if blockType === 'consent_widget'}
															<div class="preview-consent-widget">
																<div class="preview-consent-widget__heading">
																	<span class="i-ph-handshake"></span>
																	<strong>{field.label || t('同意確認', 'Consent confirmation')}</strong>
																</div>
																<p>
																	{field.text ||
																		t(
																			'Flowノードで選択した同意ポリシーがここに表示されます。',
																			'The consent policy selected on the Flow node is rendered here.'
																		)}
																</p>
																<label class="preview-check-field">
																	<input type="checkbox" disabled />
																	<span>{t('内容を確認しました', 'I have reviewed the consent items')}</span>
																</label>
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
														{:else if blockType === 'security_verification'}
															<div class="preview-security-box">
																<span class="i-ph-shield-check"></span>
																<span>{field.text || field.label}</span>
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
								<h2>{$LL.admin_forms_empty()}</h2>
								<p class="muted">{$LL.admin_forms_select_profile()}</p>
								<button class="btn-primary" type="button" onclick={newProfile}>
									<span class="i-ph-plus"></span>
									{$LL.admin_forms_create()}
								</button>
							</div>
						{/if}
					{:else}
						<div class="editor">
							<div class="editor-head">
								<h2>{draft.id ? draft.display_name : $LL.admin_forms_new_profile()}</h2>
								<label class="toggle">
									<input type="checkbox" bind:checked={draft.is_active} />
									<span>{$LL.admin_forms_active()}</span>
								</label>
							</div>

							<div class="note">{$LL.admin_forms_schema_required_note()}</div>

							<div class="grid two">
								<label>
									<span>{$LL.admin_forms_profile_key()}</span>
									<input
										bind:value={draft.profile_key}
										disabled={draft.is_system || Boolean(draft.id)}
									/>
								</label>
								<label>
									<span>{$LL.admin_forms_kind()}</span>
									<select bind:value={draft.form_kind}>
										{#each kindOptions as kind}
											<option value={kind}>{kindLabel(kind)}</option>
										{/each}
									</select>
								</label>
							</div>

							<label>
								<span>{$LL.admin_forms_display_name()}</span>
								<input bind:value={draft.display_name} />
							</label>

							<label>
								<span>{$LL.admin_forms_description_label()}</span>
								<textarea rows="3" bind:value={draft.description}></textarea>
							</label>

							<label class="canvas-layout-select">
								<span>{t('キャンバス', 'Canvas')}</span>
								<select
									value={normalizeSettings(draft.settings).canvas_layout}
									onchange={(event) =>
										(draft.settings = {
											...draft.settings,
											canvas_layout: event.currentTarget.value as FormProfileCanvasLayout
										})}
								>
									<option value="narrow">{t('縦長', 'Narrow')}</option>
									<option value="wide">{t('横長', 'Wide')}</option>
								</select>
							</label>

							<AdminTabs
								items={editorTabItems}
								active={editorTab}
								onChange={(tabId) => (editorTab = tabId as FormEditorTab)}
								ariaLabel={$LL.admin_forms_fields()}
							/>

							{#if editorTab === 'items'}
								<div class="tab-panel-head" id="form-editor-items">
									<p class="muted">
										{t(
											'左のパーツを追加し、中央で順番を並べ替え、右で詳細を設定します。',
											'Add parts from the left, arrange them in the canvas, then configure them on the right.'
										)}
									</p>
								</div>

								<div class="form-builder">
									<aside class="parts-panel" aria-label={t('フォームパーツ', 'Form parts')}>
										{#each formParts as part (part.type)}
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
										aria-label={t('フォーム配置', 'Form canvas')}
										ondragover={(event) => handleCanvasDragOver(event, orderedDraftBlocks.length)}
										ondrop={(event) => handleCanvasDrop(event, orderedDraftBlocks.length)}
									>
										{#each draftLayoutSections as section (section.id)}
											{#if section.row}
												<button
													type="button"
													class:active={isDropTarget(section.row.index)}
													class="drop-zone"
													ondragover={(event) => handleCanvasDragOver(event, section.row?.index ?? 0)}
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
														aria-label={section.columns > 1 ? columnLabel(column) : t('フォーム行', 'Form row')}
														ondragover={(event) => handleCanvasDragOver(event, columnEndIndex, column)}
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
																ondragover={(event) => handleCanvasDragOver(event, item.index, column)}
																ondrop={(event) => handleCanvasDrop(event, item.index, column)}
															>
																{isDropTarget(item.index, column) ? t('ここに配置', 'Drop here') : ''}
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
																value_type: event.currentTarget.value as FormProfileValueType
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
														onchange={(event) =>
															updateField(selectedBlockIndex, {
																required: event.currentTarget.checked
															})}
													/>
													<span>{$LL.admin_forms_field_required()}</span>
												</label>
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
													<span>{$LL.admin_forms_field_required()}</span>
												</label>
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
											{:else if blockType === 'security_verification'}
												<label>
													<span>{t('表示テキスト', 'Display text')}</span>
													<input
														value={selectedBlock.text ?? ''}
														oninput={(event) =>
															updateField(selectedBlockIndex, { text: event.currentTarget.value })}
													/>
												</label>
											{:else if blockType === 'divider'}
												<label>
													<span>{t('ラベル（任意）', 'Label (optional)')}</span>
													<input
														value={dividerLabel(selectedBlock)}
														placeholder={t('または', 'or')}
														oninput={(event) =>
															updateField(selectedBlockIndex, {
																label: event.currentTarget.value || 'Divider',
																text: null
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
								<div
									class:wide-canvas={normalizeSettings(draft.settings).canvas_layout === 'wide'}
									class="form-preview draft-preview"
									id="form-editor-preview"
									aria-label={$LL.admin_forms_preview()}
								>
									{#if draftLayoutSections.every((section) => section.items.length === 0)}
										<p class="muted">{$LL.admin_forms_no_fields()}</p>
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
																			<strong>{$LL.admin_forms_required_mark()}</strong>
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
																		<div class="preview-field">
																			<span>{t('メールアドレス', 'Email address')}</span>
																			<input readonly placeholder="you@example.com" />
																		</div>
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-envelope-simple"></span>
																			{field.label || authWidgetDefaultLabel(method)}
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
																			{field.label || authWidgetDefaultLabel(method)}
																		</button>
																	{:else if method === 'external_idp'}
																		<button class="preview-auth-button secondary" type="button">
																			<span class="i-ph-globe"></span>
																			{field.label || authWidgetDefaultLabel(method)}
																		</button>
																	{:else}
																		<button class="preview-auth-button" type="button">
																			<span class="i-ph-key"></span>
																			{field.label || authWidgetDefaultLabel(method)}
																		</button>
																	{/if}
															</div>
														{:else if blockType === 'consent_widget'}
															<div class="preview-consent-widget">
																<div class="preview-consent-widget__heading">
																	<span class="i-ph-handshake"></span>
																	<strong>{field.label || t('同意確認', 'Consent confirmation')}</strong>
																</div>
																<p>
																	{field.text ||
																		t(
																			'Flowノードで選択した同意ポリシーがここに表示されます。',
																			'The consent policy selected on the Flow node is rendered here.'
																		)}
																</p>
																<label class="preview-check-field">
																	<input type="checkbox" disabled />
																	<span>{t('内容を確認しました', 'I have reviewed the consent items')}</span>
																</label>
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
															{:else if blockType === 'security_verification'}
																<div class="preview-security-box">
																	<span class="i-ph-shield-check"></span>
																	<span>{field.text || field.label}</span>
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
								<div class="localization-panel" id="form-editor-localization">
									<p class="muted">
										{t(
											'項目ごとの表示名を言語別に設定します。内部IDは自動採番され、ローカライズ値の紐付けに使います。',
											'Set per-language labels for each item. Internal IDs are generated automatically and used as localization keys.'
										)}
									</p>
									<div class="localization-table-wrap">
										<table class="localization-table">
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
																	placeholder={field.label || field.field}
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
										</table>
									</div>
								</div>
							{/if}

							<div class="actions">
								<button
									class="btn-danger"
									type="button"
									onclick={deleteProfile}
									disabled={saving || !draft.id || draft.is_system}
								>
									{$LL.admin_forms_delete()}
								</button>
								<div class="actions-right">
									<button
										class="btn-secondary"
										type="button"
										onclick={() => {
											if (selectedProfile) selectProfile(selectedProfile);
											else viewMode = 'preview';
										}}
										disabled={saving}
									>
										{$LL.admin_forms_cancel()}
									</button>
									<button class="btn-primary" type="button" onclick={saveProfile} disabled={saving}>
										{saving ? $LL.admin_forms_saving() : $LL.admin_forms_save()}
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
	.profile-list {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.5rem;
	}
	.profile-row {
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
	.profile-row.active,
	.profile-row:hover {
		background: var(--color-surface-muted);
	}
	.profile-row small,
	.muted,
	.note {
		color: var(--color-text-muted);
	}
	.detail-panel,
	.editor {
		display: grid;
		gap: 1rem;
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
	.form-preview {
		display: grid;
		gap: 1.15rem;
		width: min(100%, 420px);
		max-width: 420px;
		border: 1px solid var(--color-border);
		border-radius: 24px;
		background: var(--color-surface);
		padding: 2.75rem 2rem;
	}
	.form-preview.wide-canvas {
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
		color: var(--color-primary-contrast);
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
	.localization-table-wrap {
		overflow-x: auto;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}
	.localization-table {
		width: 100%;
		min-width: 760px;
		border-collapse: collapse;
	}
	.localization-table th,
	.localization-table td {
		border-bottom: 1px solid var(--color-border);
		padding: 0.75rem;
		text-align: left;
		vertical-align: top;
	}
	.localization-table th {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		text-transform: uppercase;
	}
	.localization-table tr:last-child td {
		border-bottom: 0;
	}
	.localization-table td:first-child {
		display: grid;
		gap: 0.2rem;
		min-width: 180px;
	}
	.localization-table td:first-child small {
		color: var(--color-text-muted);
	}
	.localization-table code {
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
	.localization-table input {
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
	.form-builder {
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
		color: var(--color-primary-contrast);
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
		.form-builder {
			grid-template-columns: 1fr;
		}
		.preview-layout-row {
			grid-template-columns: 1fr !important;
		}
	}
</style>
