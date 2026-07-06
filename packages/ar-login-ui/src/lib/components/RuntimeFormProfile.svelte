<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type {
		FlowRuntimeConsentPolicyContent,
		FlowRuntimeConsentPolicyOption
	} from '$lib/api/flow-runtime';
	import PinCodeInput from '$lib/components/PinCodeInput.svelte';
	import SanitizedHtml from '$lib/components/SanitizedHtml.svelte';
	import TurnstileWidget from '$lib/components/TurnstileWidget.svelte';
	import { sanitizeRuntimeConsentHtml } from '$lib/consent/runtime-consent-html';

	type RuntimeField = {
		field: string;
		label: string;
		required: boolean;
		block_id?: string | null;
		block_type?: string;
		value_type?: string | null;
		auth_method?: string | null;
		code_input_mode?: string | null;
		external_idp_show_action_text?: boolean | null;
		text?: string | null;
		help_text?: string | null;
		placeholder?: string | null;
		human_verification_timing?: 'initial' | 'submit' | null;
		layout_columns?: number | null;
		layout_column?: number | null;
	};

	type RuntimeLayoutSection = {
		id: string;
		columns: number;
		items: RuntimeField[];
	};

	type RuntimeFormProfile = {
		display_name?: string;
		description?: string | null;
		fields?: RuntimeField[];
		settings?: Record<string, unknown>;
	};

	type RuntimeExternalProvider = {
		id: string;
		label: string;
		iconUrl?: string | null;
		iconClass?: string | null;
		style?: string;
	};

	type AuthMethod =
		| 'passkey'
		| 'mail_otp'
		| 'mail_otp_totp'
		| 'totp'
		| 'external_idp'
		| 'directory_password';
	type AuthAction =
		| 'send_mail_otp'
		| 'resend_mail_otp'
		| 'start_totp'
		| 'verify_code'
		| 'back';
	type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha' | 'custom';
	type HumanVerificationMode = 'managed' | 'checkbox' | 'invisible' | 'score';
	type CaptchaTheme = 'auto' | 'light' | 'dark';

	type Props = {
		profile: Record<string, unknown> | null;
		disabled?: boolean;
		fieldValues?: Record<string, string | boolean>;
		fieldErrors?: Record<string, string>;
		authMethodMode?: 'login' | 'signup';
		methodAvailability?: Partial<Record<AuthMethod, boolean>>;
		methodLoading?: Partial<Record<AuthMethod, boolean>>;
		externalProviders?: RuntimeExternalProvider[];
		consentPolicy?: FlowRuntimeConsentPolicyContent | null;
		consentDecisions?: Record<string, boolean>;
		consentSelectedValues?: Record<string, string>;
		consentReady?: boolean;
		humanVerificationRequired?: boolean;
		humanVerificationSiteKey?: string | null;
		humanVerificationProvider?: HumanVerificationProvider;
		humanVerificationMode?: HumanVerificationMode;
		humanVerificationAction?: string;
		humanVerificationTheme?: CaptchaTheme;
		humanVerificationLanguage?: string;
		humanVerificationToken?: string;
		humanVerificationResetKey?: number;
		humanVerificationVisible?: boolean;
		humanVerificationLoadingLabel?: string;
		humanVerificationErrorLabel?: string;
		onFieldValueChange?: (field: string, value: string | boolean) => void;
		onAuthAction?: (method: AuthMethod, action?: AuthAction) => void;
		onExternalProviderAction?: (providerId: string) => void;
		onConsentDecisionChange?: (statementId: string, checked: boolean) => void;
		onConsentSelectedValueChange?: (statementId: string, value: string) => void;
	};

	let {
		profile,
		disabled = false,
		fieldValues = {},
		fieldErrors = {},
		authMethodMode = 'login',
		methodAvailability = {},
		methodLoading = {},
		externalProviders = [],
		consentPolicy = null,
		consentDecisions = {},
		consentSelectedValues = {},
		consentReady = true,
		humanVerificationRequired = false,
		humanVerificationSiteKey = null,
		humanVerificationProvider = 'turnstile',
		humanVerificationMode = 'managed',
		humanVerificationAction = 'authrim-login',
		humanVerificationTheme = 'auto',
		humanVerificationLanguage = 'auto',
		humanVerificationToken = $bindable(''),
		humanVerificationResetKey = 0,
		humanVerificationVisible = false,
		humanVerificationLoadingLabel = 'Loading security check...',
		humanVerificationErrorLabel = 'Security check could not be loaded. Reload the page and try again.',
		onFieldValueChange,
		onAuthAction,
		onExternalProviderAction,
		onConsentDecisionChange,
		onConsentSelectedValueChange
	}: Props = $props();

	function isRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
	}

	function readString(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function readBoolean(value: unknown): boolean {
		return value === true;
	}

	function readLayoutInteger(value: unknown, fallback = 1): number {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.max(1, Math.min(2, Math.trunc(value)));
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return Math.max(1, Math.min(2, Math.trunc(parsed)));
		}
		return fallback;
	}

	function readOptionalLayoutInteger(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.max(1, Math.min(2, Math.trunc(value)));
		}
		if (typeof value === 'string' && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return Math.max(1, Math.min(2, Math.trunc(parsed)));
		}
		return null;
	}

	function normalizeField(value: unknown): RuntimeField | null {
		if (!isRecord(value)) return null;
		const field = readString(value.field);
		const label = readString(value.label) ?? field;
		if (!field || !label) return null;
		return {
			field,
			label,
			required: readBoolean(value.required),
			block_id: readString(value.block_id),
			block_type: readString(value.block_type) ?? 'identity_field',
			value_type: readString(value.value_type),
			auth_method: readString(value.auth_method),
			code_input_mode: readString(value.code_input_mode),
			external_idp_show_action_text: value.external_idp_show_action_text === true,
			text: readString(value.text),
			help_text: readString(value.help_text),
			placeholder: readString(value.placeholder),
			human_verification_timing:
				value.human_verification_timing === 'submit' ? 'submit' : 'initial',
			layout_columns: readLayoutInteger(value.layout_columns),
			layout_column: readOptionalLayoutInteger(value.layout_column)
		};
	}

	function normalizeProfile(value: Record<string, unknown> | null): RuntimeFormProfile | null {
		if (!value || !Array.isArray(value.fields)) return null;
		return {
			display_name: readString(value.display_name) ?? undefined,
			description: readString(value.description),
			settings: isRecord(value.settings) ? value.settings : {},
			fields: value.fields.map(normalizeField).filter((field) => field !== null)
		};
	}

	const normalizedProfile = $derived(normalizeProfile(profile));
	const renderedFields = $derived(normalizedProfile?.fields ?? []);
	const renderedSections = $derived(buildLayoutSections(renderedFields));

	function isSecurityVerificationField(field: RuntimeField): boolean {
		const blockType = field.block_type ?? '';
		const fieldName = field.field.toLowerCase();
		return (
			blockType === 'security_verification' ||
			fieldName === 'security_verification' ||
			fieldName.startsWith('security.')
		);
	}

	function shouldShowSecurityVerification(field: RuntimeField): boolean {
		if (!humanVerificationRequired || !humanVerificationSiteKey) return false;
		const timing = field.human_verification_timing === 'submit' ? 'submit' : 'initial';
		return timing === 'initial' || humanVerificationVisible;
	}

	function authWidgetMethod(field: RuntimeField): AuthMethod {
		const method = field.auth_method ?? 'passkey';
		if (
			method === 'mail_otp' ||
			method === 'mail_otp_totp' ||
			method === 'totp' ||
			method === 'external_idp' ||
			method === 'directory_password' ||
			method === 'passkey'
		) {
			return method;
		}
		return 'passkey';
	}

	function authMethodAvailable(method: AuthMethod): boolean {
		if (method === 'mail_otp_totp') {
			return (
				methodAvailability.mail_otp_totp !== false &&
				methodAvailability.mail_otp !== false &&
				methodAvailability.totp !== false
			);
		}
		return methodAvailability[method] !== false;
	}

	function authMethodBusy(method: AuthMethod): boolean {
		if (method === 'mail_otp_totp') {
			return methodLoading.mail_otp === true || methodLoading.totp === true;
		}
		return methodLoading[method] === true;
	}

	const defaultAuthWidgetLabels = {
		loginPasskey: new Set([
			'Sign in with Passkey',
			'Passkeyでサインイン',
			'使用 Passkey 登录',
			'使用 Passkey 登入',
			'Iniciar sesión con Passkey',
			'Entrar com Passkey',
			'Se connecter avec Passkey',
			'Mit Passkey anmelden',
			'Passkey로 로그인',
			'Войти с Passkey',
			'Masuk dengan Passkey'
		]),
		registerPasskey: new Set([
			'Create Account with Passkey',
			'Passkeyでアカウント作成',
			'使用 Passkey 创建账户',
			'使用 Passkey 建立帳戶',
			'Crear cuenta con Passkey',
			'Criar conta com Passkey',
			'Créer un compte avec Passkey',
			'Konto mit Passkey erstellen',
			'Passkey로 계정 만들기',
			'Создать аккаунт с Passkey',
			'Buat akun dengan Passkey'
		]),
		loginMailOtp: new Set([
			'Send verification code',
			'Send code by email',
			'認証コードを送信',
			'認証コードをメール送信',
			'发送验证码',
			'傳送驗證碼',
			'Enviar código de verificación',
			'Enviar código de verificação',
			'Envoyer le code de vérification',
			'Bestätigungscode senden',
			'인증 코드 보내기',
			'Отправить код подтверждения',
			'Kirim kode verifikasi'
		]),
		registerMailOtp: new Set([
			'Sign up with verification code',
			'Send code by email',
			'認証コードで登録',
			'認証コードをメール送信'
		]),
		loginTotp: new Set([
			'Continue with authenticator app',
			'Sign in with authenticator app',
			'認証アプリで続行',
			'認証アプリでログイン'
		]),
		registerTotp: new Set([
			'Create account with authenticator app',
			'Sign up with authenticator app',
			'認証アプリでアカウント作成',
			'認証アプリで新規登録'
		]),
		externalIdp: new Set([
			'Continue with external IdP',
			'外部IdPで続行',
			'使用外部 IdP 继续',
			'使用外部 IdP 繼續',
			'Continuar con IdP externo',
			'Continuar com IdP externo',
			'Continuer avec un IdP externe',
			'Mit externem IdP fortfahren',
			'외부 IdP로 계속',
			'Продолжить через внешний IdP',
			'Lanjutkan dengan IdP eksternal',
			'Ext. IdP'
		]),
		directoryPassword: new Set([
			'Sign in with directory password',
			'ディレクトリパスワードでサインイン',
			'使用目录密码登录',
			'使用目錄密碼登入',
			'Iniciar sesión con contraseña de directorio',
			'Entrar com senha do diretório',
			'Se connecter avec le mot de passe du répertoire',
			'Mit Verzeichnispasswort anmelden',
			'디렉터리 비밀번호로 로그인',
			'Войти с паролем каталога',
			'Masuk dengan kata sandi direktori'
		])
	};

	function authWidgetLabel(field: RuntimeField): string {
		const method = authWidgetMethod(field);
		if (field.label) {
			if (method === 'passkey') {
				if (defaultAuthWidgetLabels.registerPasskey.has(field.label)) {
					return $LL.register_createWithPasskey();
				}
				if (defaultAuthWidgetLabels.loginPasskey.has(field.label)) {
					return $LL.login_signInWithPasskey();
				}
			}
			if (method === 'mail_otp') {
				if (defaultAuthWidgetLabels.registerMailOtp.has(field.label)) {
					return $LL.register_sendCode();
				}
				if (defaultAuthWidgetLabels.loginMailOtp.has(field.label)) {
					return $LL.login_sendCode();
				}
			}
			if (method === 'totp' || method === 'mail_otp_totp') {
				if (authMethodMode === 'signup' || defaultAuthWidgetLabels.registerTotp.has(field.label)) {
					return $LL.register_createWithTotp();
				}
				if (defaultAuthWidgetLabels.loginTotp.has(field.label)) {
					return $LL.login_totpContinue();
				}
			}
			if (method === 'external_idp' && defaultAuthWidgetLabels.externalIdp.has(field.label)) {
				return 'Ext. IdP';
			}
			if (
				method === 'directory_password' &&
				defaultAuthWidgetLabels.directoryPassword.has(field.label)
			) {
				return $LL.login_signInWithDirectory({ label: 'Directory Password' });
			}
			return field.label;
		}
		switch (method) {
			case 'mail_otp':
				return $LL.login_sendCode();
			case 'mail_otp_totp':
				return authMethodMode === 'signup'
					? $LL.register_createWithTotp()
					: $LL.login_totpContinue();
			case 'totp':
				return authMethodMode === 'signup'
					? $LL.register_createWithTotp()
					: $LL.login_totpContinue();
			case 'external_idp':
				return 'Ext. IdP';
			case 'directory_password':
				return $LL.login_signInWithDirectory({ label: 'Directory Password' });
			case 'passkey':
			default:
				return $LL.login_signInWithPasskey();
		}
	}

	function dividerLabel(field: RuntimeField): string {
		return field.text && field.text !== 'Divider' ? field.text : '';
	}

	function fieldStringValue(field: RuntimeField): string {
		const value = fieldValues[field.field];
		if (typeof value === 'string') return value;
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		return '';
	}

	function fieldBooleanValue(field: RuntimeField): boolean {
		return fieldValues[field.field] === true || fieldValues[field.field] === 'true';
	}

	function setFieldValue(field: RuntimeField, value: string | boolean) {
		onFieldValueChange?.(field.field, value);
	}

	function consentItemHtml(item: FlowRuntimeConsentPolicyContent['items'][number]): string {
		if (item.inline_content) return sanitizeRuntimeConsentHtml(item.inline_content);
		const fallback = item.description
			? `<strong>${item.title}</strong><br>${item.description}`
			: item.title;
		return sanitizeRuntimeConsentHtml(fallback);
	}

	function consentOptionHtml(option: FlowRuntimeConsentPolicyOption): string {
		const body = option.description || option.label || option.value;
		return sanitizeRuntimeConsentHtml(body);
	}

	function authButtonDisabled(method: AuthMethod): boolean {
		return disabled || !consentReady || !authMethodAvailable(method);
	}

	function codeInputMethod(field: RuntimeField): 'mail_otp' | 'totp' {
		const configured = field.code_input_mode ?? field.auth_method ?? 'auto';
		if (configured === 'mail_otp' || configured === 'totp') return configured;
		const runtimeMethod = fieldValues.code_input_method;
		if (runtimeMethod === 'mail_otp' || runtimeMethod === 'totp') return runtimeMethod;
		if (fieldValues.totp_code_requested === true || fieldValues.totp_code_requested === 'true') {
			return 'totp';
		}
		return 'mail_otp';
	}

	function codeInputFieldName(method: 'mail_otp' | 'totp'): 'mail_otp_code' | 'totp_code' {
		return method === 'mail_otp' ? 'mail_otp_code' : 'totp_code';
	}

	function codeInputValue(method: 'mail_otp' | 'totp'): string {
		const value = fieldValues[codeInputFieldName(method)];
		return typeof value === 'string' ? value : '';
	}

	function codeInputLength(method: 'mail_otp' | 'totp'): number {
		const configured = numberField(method === 'mail_otp' ? 'mail_otp_code_length' : 'totp_code_length', 6);
		return configured === 8 ? 8 : 6;
	}

	function numberField(name: string, fallback: number): number {
		const raw = fieldValues[name];
		const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'boolean' ? NaN : NaN;
		return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
	}

	function mailOtpRemainingSeconds(): number {
		return numberField('mail_otp_resend_remaining', 0);
	}

	function mailOtpTotalSeconds(): number {
		return Math.max(1, numberField('mail_otp_resend_total', 60));
	}

	function mailOtpProgressStyle(): string {
		const remaining = Math.min(mailOtpRemainingSeconds(), mailOtpTotalSeconds());
		const percent = Math.round((remaining / mailOtpTotalSeconds()) * 100);
		return `width: ${percent}%;`;
	}

	function showExternalProviderActionText(field: RuntimeField): boolean {
		return field.external_idp_show_action_text === true;
	}

	function externalProviderBaseLabel(label: string): string {
		const trimmed = label.trim();
		for (const suffix of ['でログイン', 'で続行']) {
			if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length).trim();
		}
		for (const prefix of ['Continue with ', 'Sign in with ', 'Login with ']) {
			if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
		}
		return trimmed || 'Ext. IdP';
	}

	function externalProviderButtonLabel(field: RuntimeField, label: string, stripActionText = false): string {
		const trimmed = label.trim();
		const baseLabel = stripActionText ? externalProviderBaseLabel(trimmed) : trimmed || 'Ext. IdP';
		return showExternalProviderActionText(field)
			? $LL.login_continueWith({ provider: baseLabel })
			: baseLabel;
	}

	function fieldKey(field: RuntimeField): string {
		return field.block_id ?? field.field;
	}

	function buildLayoutSections(fields: RuntimeField[]): RuntimeLayoutSection[] {
		const sections: RuntimeLayoutSection[] = [{ id: 'implicit-layout-row', columns: 1, items: [] }];
		let current = sections[0];
		for (const [index, field] of fields.entries()) {
			if (field.block_type === 'layout_row') {
				current = {
					id: field.block_id ?? `layout-row-${index}`,
					columns: readLayoutInteger(field.layout_columns),
					items: []
				};
				sections.push(current);
				continue;
			}
			current.items.push(field);
		}
		return sections.filter((section) => section.items.length > 0);
	}

	function layoutGridStyle(columns: number): string {
		return `grid-template-columns: repeat(${readLayoutInteger(columns)}, minmax(0, 1fr));`;
	}

	function layoutCellStyle(field: RuntimeField, columns: number): string | undefined {
		const column = readOptionalLayoutInteger(field.layout_column);
		if (columns < 2 || !column) return undefined;
		return `grid-column: ${Math.min(column, columns)} / span 1;`;
	}
</script>

{#snippet runtimeField(field: RuntimeField)}
	{@const blockType = field.block_type ?? 'identity_field'}
	{#if blockType === 'heading'}
		<div class="runtime-form-heading">
			<h2>{field.label}</h2>
			{#if field.text}
				<p>{field.text}</p>
			{/if}
		</div>
	{:else if blockType === 'text'}
		<p class="runtime-form-text">{field.text || field.label}</p>
	{:else if blockType === 'consent_widget'}
		<div class="runtime-form-consent-widget">
			<div>
				<span class="i-ph-handshake"></span>
				<strong>{field.label}</strong>
			</div>
			{#if field.text}
				<p>{field.text}</p>
			{/if}
			{#if consentPolicy?.items.length}
				<div class="runtime-consent-items">
					{#each consentPolicy.items as item (item.statement_id)}
						<div class="runtime-consent-item">
							{#if item.content_mode === 'radio' && item.options?.length}
								<fieldset class="runtime-consent-options">
									<legend class="sr-only">{item.title}</legend>
									{#each item.options as option (option.id)}
										<label class="runtime-consent-choice">
											<input
												type="radio"
												name={`runtime-consent-${item.statement_id}`}
												value={option.value}
												checked={consentSelectedValues[item.statement_id] === option.value}
												required={item.is_required}
												{disabled}
												onchange={() =>
													onConsentSelectedValueChange?.(item.statement_id, option.value)}
											/>
											<SanitizedHtml
												class="runtime-consent-content"
												sanitizedHtml={consentOptionHtml(option)}
											/>
										</label>
									{/each}
								</fieldset>
							{:else if item.checkbox_mode === 'none' || item.content_mode === 'display_only'}
								<SanitizedHtml
									tag="div"
									class="runtime-consent-content"
									sanitizedHtml={consentItemHtml(item)}
								/>
							{:else}
								<label class="runtime-consent-choice">
									<input
										type="checkbox"
										checked={consentDecisions[item.statement_id] === true}
										required={item.is_required || item.checkbox_mode === 'required'}
										{disabled}
										onchange={(event) =>
											onConsentDecisionChange?.(
												item.statement_id,
												(event.currentTarget as HTMLInputElement).checked
											)}
									/>
									<SanitizedHtml
										class="runtime-consent-content"
										sanitizedHtml={consentItemHtml(item)}
									/>
								</label>
							{/if}
							{#if item.document_url}
								<a
									class="runtime-consent-link"
									href={item.document_url}
									target="_blank"
									rel="noopener noreferrer"
								>
									{item.document_url}
								</a>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<span class="runtime-checkbox-row">
					<input {disabled} type="checkbox" />
					<span>{$LL.consent_items_required_title()}</span>
				</span>
			{/if}
		</div>
	{:else if blockType === 'divider'}
		{@const label = dividerLabel(field)}
		<div class="runtime-form-divider" class:has-label={Boolean(label)}>
			{#if label}
				<span>{label}</span>
			{/if}
		</div>
	{:else if isSecurityVerificationField(field)}
		{#if shouldShowSecurityVerification(field) && humanVerificationSiteKey}
			<div class="runtime-security-verification">
				<TurnstileWidget
					siteKey={humanVerificationSiteKey}
					provider={humanVerificationProvider}
					mode={humanVerificationMode}
					action={humanVerificationAction}
					theme={humanVerificationTheme}
					language={humanVerificationLanguage}
					bind:token={humanVerificationToken}
					resetKey={humanVerificationResetKey}
					{disabled}
					loadingLabel={humanVerificationLoadingLabel}
					errorLabel={humanVerificationErrorLabel}
				/>
			</div>
		{/if}
	{:else if blockType === 'code_input_widget'}
		{@const method = codeInputMethod(field)}
		<div class="runtime-code-input-widget">
			{#if field.text}
				<p>{field.text}</p>
			{/if}
			<div class="runtime-form-field">
				<span>{field.label || $LL.login_totpCodeLabel()}</span>
				<PinCodeInput
					value={codeInputValue(method)}
					length={codeInputLength(method)}
					disabled={disabled || authMethodBusy(method)}
					digitLabel={(position) => $LL.emailCode_digitLabel({ position })}
					onValueChange={(nextValue) =>
						onFieldValueChange?.(codeInputFieldName(method), nextValue)}
				/>
			</div>
			{#if method === 'mail_otp'}
				<div class="runtime-code-progress" aria-hidden="true">
					<span style={mailOtpProgressStyle()}></span>
				</div>
				<div class="runtime-code-actions">
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={disabled || authMethodBusy(method)}
						onclick={() => onAuthAction?.(method, 'back')}
					>
						<span class="i-ph-arrow-left"></span>
						{$LL.common_backToLogin()}
					</button>
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={disabled || authMethodBusy(method) || mailOtpRemainingSeconds() > 0}
						onclick={() => onAuthAction?.(method, 'resend_mail_otp')}
					>
						<span class="i-ph-arrow-clockwise"></span>
						{mailOtpRemainingSeconds() > 0
							? $LL.emailCode_resendTimer({ seconds: mailOtpRemainingSeconds() })
							: $LL.emailCode_resendButton()}
					</button>
				</div>
			{:else}
				<button
					class="runtime-auth-button secondary"
					type="button"
					disabled={disabled || authMethodBusy(method)}
					onclick={() => onAuthAction?.(method, 'back')}
				>
					<span class="i-ph-arrow-left"></span>
					{$LL.common_backToLogin()}
				</button>
			{/if}
			<button
				class="runtime-auth-button"
				type="button"
				disabled={authButtonDisabled(method) || authMethodBusy(method)}
				onclick={() => onAuthAction?.(method, 'verify_code')}
			>
				<span class="i-ph-check-circle"></span>
				{method === 'mail_otp' ? $LL.emailCode_verifyButton() : $LL.login_totpVerify()}
			</button>
			{#if fieldErrors[method === 'mail_otp' ? 'mail_otp_code' : 'totp_code']}
				<small class="runtime-form-error"
					>{fieldErrors[method === 'mail_otp' ? 'mail_otp_code' : 'totp_code']}</small
				>
			{/if}
		</div>
	{:else if blockType === 'auth_widget'}
		{@const method = authWidgetMethod(field)}
		{#if authMethodAvailable(method)}
			<div class="runtime-auth-widget">
				{#if method === 'mail_otp'}
					<label class="runtime-form-field">
						<span>{$LL.common_email()}</span>
						<input
							value={String(fieldValues.email ?? '')}
							disabled={disabled || authMethodBusy(method)}
							placeholder="you@example.com"
							type="email"
							oninput={(event) =>
								onFieldValueChange?.('email', (event.currentTarget as HTMLInputElement).value)}
						/>
					</label>
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={authButtonDisabled(method) || authMethodBusy(method)}
						onclick={() => onAuthAction?.(method)}
					>
						<span class="i-ph-envelope-simple"></span>
						{authWidgetLabel(field)}
					</button>
				{:else if method === 'mail_otp_totp'}
					<label class="runtime-form-field">
						<span>{$LL.login_totpIdentifierLabel()}</span>
						<input
							value={String(fieldValues.identifier ?? fieldValues.email ?? fieldValues.totp_identifier ?? '')}
							disabled={disabled || authMethodBusy(method)}
							placeholder={$LL.login_totpIdentifierPlaceholder()}
							autocomplete="username"
							oninput={(event) =>
								onFieldValueChange?.('identifier', (event.currentTarget as HTMLInputElement).value)}
						/>
					</label>
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={authButtonDisabled('mail_otp') || authMethodBusy('mail_otp')}
						onclick={() => onAuthAction?.('mail_otp', 'send_mail_otp')}
					>
						<span class="i-ph-envelope-simple"></span>
						{$LL.login_sendCode()}
					</button>
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={authButtonDisabled('totp') || authMethodBusy('totp')}
						onclick={() => onAuthAction?.('totp', 'start_totp')}
					>
						<span class="i-ph-device-mobile"></span>
						{authMethodMode === 'signup' ? $LL.register_createWithTotp() : $LL.login_totpContinue()}
					</button>
				{:else if method === 'directory_password'}
					<label class="runtime-form-field">
						<span>{$LL.login_directoryUsernamePlaceholder()}</span>
						<input
							value={String(fieldValues.directory_username ?? '')}
							disabled={disabled || authMethodBusy(method)}
							placeholder={$LL.login_directoryUsernamePlaceholder()}
							oninput={(event) =>
								onFieldValueChange?.(
									'directory_username',
									(event.currentTarget as HTMLInputElement).value
								)}
						/>
					</label>
					<label class="runtime-form-field">
						<span>{$LL.login_directoryPasswordLabel()}</span>
						<input
							value={String(fieldValues.directory_password ?? '')}
							disabled={disabled || authMethodBusy(method)}
							placeholder={$LL.login_directoryPasswordPlaceholder()}
							type="password"
							oninput={(event) =>
								onFieldValueChange?.(
									'directory_password',
									(event.currentTarget as HTMLInputElement).value
								)}
						/>
					</label>
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={authButtonDisabled(method) || authMethodBusy(method)}
						onclick={() => onAuthAction?.(method)}
					>
						<span class="i-ph-identification-card"></span>
						{authWidgetLabel(field)}
					</button>
				{:else if method === 'totp'}
					{#if authMethodMode === 'login'}
						<label class="runtime-form-field">
							<span>{$LL.login_totpIdentifierLabel()}</span>
							<input
								value={String(fieldValues.totp_identifier ?? fieldValues.identifier ?? '')}
								disabled={disabled || authMethodBusy(method)}
								placeholder={$LL.login_totpIdentifierPlaceholder()}
								autocomplete="username"
								oninput={(event) =>
									onFieldValueChange?.(
										'totp_identifier',
										(event.currentTarget as HTMLInputElement).value
								)}
							/>
						</label>
					{/if}
					<button
						class="runtime-auth-button secondary"
						type="button"
						disabled={authButtonDisabled(method) || authMethodBusy(method)}
						onclick={() => onAuthAction?.(method, 'start_totp')}
					>
						<span class="i-ph-device-mobile"></span>
						{authWidgetLabel(field)}
					</button>
				{:else if method === 'external_idp'}
					{#if externalProviders.length}
						{#each externalProviders as provider (provider.id)}
							{@const buttonLabel = externalProviderButtonLabel(field, provider.label)}
							<button
								class="runtime-auth-button secondary"
								type="button"
								disabled={authButtonDisabled(method) || authMethodBusy(method)}
								onclick={() => onExternalProviderAction?.(provider.id)}
								style={provider.style ?? ''}
								aria-label={buttonLabel}
							>
								{#if provider.iconUrl}
									<img src={provider.iconUrl} alt="" class="runtime-auth-provider-icon" />
								{:else if provider.iconClass}
									<span class={provider.iconClass}></span>
								{:else}
									<span class="i-ph-globe"></span>
								{/if}
								{buttonLabel}
							</button>
						{/each}
					{:else}
						{@const buttonLabel = externalProviderButtonLabel(field, authWidgetLabel(field), true)}
						<button
							class="runtime-auth-button secondary"
							type="button"
							disabled
							aria-label={buttonLabel}
						>
							<span class="i-ph-globe"></span>
							{buttonLabel}
						</button>
					{/if}
				{:else}
					<button
						class="runtime-auth-button"
						type="button"
						disabled={authButtonDisabled(method) || authMethodBusy(method)}
						onclick={() => onAuthAction?.(method)}
					>
						<span class="i-ph-key"></span>
						{authWidgetLabel(field)}
					</button>
				{/if}
			</div>
		{/if}
	{:else}
		<label class="runtime-form-field">
			<span>
				{field.label}
				{#if field.required}
					<strong>*</strong>
				{/if}
			</span>
			{#if field.value_type === 'boolean'}
				<span class="runtime-checkbox-row">
					<input
						{disabled}
						type="checkbox"
						checked={fieldBooleanValue(field)}
						onchange={(event) =>
							setFieldValue(field, (event.currentTarget as HTMLInputElement).checked)}
					/>
					<span>{field.placeholder || field.label}</span>
				</span>
			{:else}
				<input
					{disabled}
					value={fieldStringValue(field)}
					placeholder={field.placeholder || field.label}
					oninput={(event) => setFieldValue(field, (event.currentTarget as HTMLInputElement).value)}
				/>
			{/if}
			{#if field.help_text}
				<small>{field.help_text}</small>
			{/if}
			{#if fieldErrors[field.field]}
				<small class="runtime-form-error">{fieldErrors[field.field]}</small>
			{/if}
		</label>
	{/if}
{/snippet}

{#if normalizedProfile}
	<div
		class="runtime-form-profile"
		class:is-wide={normalizedProfile.settings?.canvas_layout === 'wide'}
	>
		{#each renderedSections as section (section.id)}
			<div
				class="runtime-layout-section"
				class:has-columns={section.columns > 1}
				style={layoutGridStyle(section.columns)}
			>
				{#each section.items as field (fieldKey(field))}
					<div class="runtime-layout-cell" style={layoutCellStyle(field, section.columns)}>
						{@render runtimeField(field)}
					</div>
				{/each}
			</div>
		{/each}
	</div>
{/if}

<style>
	.runtime-form-profile {
		display: grid;
		gap: 1rem;
		width: 100%;
		justify-items: stretch;
	}

	.runtime-layout-section {
		display: grid;
		gap: 1rem;
		align-items: start;
		width: 100%;
	}

	.runtime-layout-section.has-columns {
		column-gap: 0.875rem;
		row-gap: 1rem;
	}

	.runtime-layout-cell {
		min-width: 0;
		width: 100%;
	}

	.runtime-form-text,
	.runtime-form-heading p,
	.runtime-form-field small {
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.runtime-form-field small.runtime-form-error {
		color: var(--danger, #ef4444);
	}

	.runtime-form-heading h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1.375rem;
		line-height: 1.25;
	}

	.runtime-form-field {
		display: grid;
		gap: 0.5rem;
		color: var(--text-primary);
		font-weight: 700;
	}

	.runtime-form-field strong {
		margin-left: 0.375rem;
		color: var(--color-danger, #ef4444);
		font-size: 0.75rem;
	}

	.runtime-form-field input {
		width: 100%;
		border: 1px solid var(--input-border, var(--border));
		border-radius: var(--radius-lg, var(--radius-md));
		background: var(--input-bg, var(--bg-glass));
		color: var(--text-primary);
		font: inherit;
		font-weight: 500;
		padding: 0.875rem 1rem;
	}

	.runtime-checkbox-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		font-weight: 500;
	}

	.runtime-checkbox-row input {
		width: auto;
	}

	.runtime-auth-widget {
		display: grid;
		gap: 0.875rem;
		width: 100%;
	}

	.runtime-code-input-widget {
		display: grid;
		gap: 0.875rem;
		width: 100%;
	}

	.runtime-code-input-widget p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.runtime-code-input-widget > .runtime-form-error {
		color: var(--danger, #ef4444);
		font-size: 0.875rem;
	}

	.runtime-code-progress {
		height: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--border-color, var(--border));
		border-radius: var(--radius-full, 999px);
		background: var(--bg-glass);
	}

	.runtime-code-progress span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent-color, var(--primary));
		transition: width 0.2s ease;
	}

	.runtime-code-actions {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
	}

	.runtime-auth-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 3rem;
		border: 0;
		border-radius: var(--radius-full, 999px);
		background: var(--button-primary-bg, var(--gradient-primary));
		color: var(--button-primary-text, white);
		font: inherit;
		font-weight: 700;
		padding: 0.875rem 1.25rem;
		line-height: 1.35;
		text-align: center;
		white-space: normal;
	}

	.runtime-auth-button.secondary {
		border: 1px solid var(--button-secondary-border, var(--border));
		background: var(--button-secondary-bg, var(--bg-glass));
		color: var(--button-secondary-text, var(--text-primary));
	}

	.runtime-auth-provider-icon {
		width: 1.25rem;
		height: 1.25rem;
		object-fit: contain;
		flex: 0 0 1.25rem;
	}

	.runtime-form-consent-widget {
		display: grid;
		gap: 0.75rem;
		border: 1px solid var(--border-color, var(--border));
		border-radius: var(--radius-lg, var(--radius-md));
		background: var(--card-bg-muted, var(--surface-muted, var(--bg-glass)));
		color: var(--text-primary);
		padding: 1rem;
	}

	.runtime-form-consent-widget > div {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.runtime-form-consent-widget p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.runtime-security-verification {
		display: grid;
		gap: 0.75rem;
		width: 100%;
		justify-items: center;
	}

	.runtime-consent-items,
	.runtime-consent-options {
		display: grid;
		gap: 0.75rem;
	}

	.runtime-consent-options {
		margin: 0;
		padding: 0;
		border: 0;
	}

	.runtime-consent-item {
		display: grid;
		gap: 0.5rem;
	}

	.runtime-consent-choice {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		font-weight: 500;
		line-height: 1.45;
	}

	.runtime-consent-choice input {
		margin-top: 0.1875rem;
		flex: 0 0 auto;
	}

	.runtime-consent-content {
		color: var(--text-secondary);
		font-size: 0.9rem;
		line-height: 1.5;
		min-width: 0;
	}

	.runtime-consent-content :global(p) {
		margin: 0;
	}

	.runtime-consent-content :global(strong) {
		color: var(--text-primary);
	}

	.runtime-consent-content :global(a),
	.runtime-consent-link {
		color: var(--accent-color, var(--primary));
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}

	.runtime-consent-link {
		font-size: 0.82rem;
	}

	.runtime-form-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.runtime-form-divider::before,
	.runtime-form-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-color, var(--border));
	}
</style>
