<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type {
		FlowRuntimeConsentPolicyContent,
		FlowRuntimeConsentPolicyOption
	} from '$lib/api/flow-runtime';
	import SanitizedHtml from '$lib/components/SanitizedHtml.svelte';
	import { sanitizeRuntimeConsentHtml } from '$lib/consent/runtime-consent-html';

	type RuntimeField = {
		field: string;
		label: string;
		required: boolean;
		block_type?: string;
		value_type?: string | null;
		auth_method?: string | null;
		text?: string | null;
		help_text?: string | null;
		placeholder?: string | null;
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

	type AuthMethod = 'passkey' | 'mail_otp' | 'external_idp' | 'directory_password';

	type Props = {
		profile: Record<string, unknown> | null;
		disabled?: boolean;
		fieldValues?: Record<string, string | boolean>;
		fieldErrors?: Record<string, string>;
		methodAvailability?: Partial<Record<AuthMethod, boolean>>;
		methodLoading?: Partial<Record<AuthMethod, boolean>>;
		externalProviders?: RuntimeExternalProvider[];
		consentPolicy?: FlowRuntimeConsentPolicyContent | null;
		consentDecisions?: Record<string, boolean>;
		consentSelectedValues?: Record<string, string>;
		consentReady?: boolean;
		onFieldValueChange?: (field: string, value: string | boolean) => void;
		onAuthAction?: (method: AuthMethod) => void;
		onExternalProviderAction?: (providerId: string) => void;
		onConsentDecisionChange?: (statementId: string, checked: boolean) => void;
		onConsentSelectedValueChange?: (statementId: string, value: string) => void;
	};

	let {
		profile,
		disabled = false,
		fieldValues = {},
		fieldErrors = {},
		methodAvailability = {},
		methodLoading = {},
		externalProviders = [],
		consentPolicy = null,
		consentDecisions = {},
		consentSelectedValues = {},
		consentReady = true,
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

	function normalizeField(value: unknown): RuntimeField | null {
		if (!isRecord(value)) return null;
		const field = readString(value.field);
		const label = readString(value.label) ?? field;
		if (!field || !label) return null;
		return {
			field,
			label,
			required: readBoolean(value.required),
			block_type: readString(value.block_type) ?? 'identity_field',
			value_type: readString(value.value_type),
			auth_method: readString(value.auth_method),
			text: readString(value.text),
			help_text: readString(value.help_text),
			placeholder: readString(value.placeholder)
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

	function authWidgetMethod(field: RuntimeField): AuthMethod {
		const method = field.auth_method ?? 'passkey';
		if (
			method === 'mail_otp' ||
			method === 'external_idp' ||
			method === 'directory_password' ||
			method === 'passkey'
		) {
			return method;
		}
		return 'passkey';
	}

	function authMethodAvailable(method: AuthMethod): boolean {
		return methodAvailability[method] !== false;
	}

	function authMethodBusy(method: AuthMethod): boolean {
		return methodLoading[method] === true;
	}

	function authWidgetLabel(field: RuntimeField): string {
		if (field.label) return field.label;
		switch (authWidgetMethod(field)) {
			case 'mail_otp':
				return $LL.login_sendCode();
			case 'external_idp':
				return 'Ext. IdP';
			case 'directory_password':
				return $LL.login_signInWithDirectory({ label: 'Directory Password' });
			case 'passkey':
			default:
				return $LL.login_signInWithPasskey();
		}
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
</script>

{#if normalizedProfile}
	<div
		class="runtime-form-profile"
		class:is-wide={normalizedProfile.settings?.canvas_layout === 'wide'}
	>
		{#if normalizedProfile.description}
			<p class="runtime-form-profile__description">{normalizedProfile.description}</p>
		{/if}

		{#each normalizedProfile.fields ?? [] as field (field.field)}
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
			{:else if blockType === 'security_verification'}
				<div class="runtime-form-security">
					<span class="i-ph-shield-check"></span>
					<span>{field.text || field.label}</span>
				</div>
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
				<div class="runtime-form-divider" class:has-label={Boolean(field.text || field.label)}>
					<span>{field.text || field.label}</span>
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
						{:else if method === 'external_idp'}
							{#if externalProviders.length}
								{#each externalProviders as provider (provider.id)}
									<button
										class="runtime-auth-button secondary"
										type="button"
										disabled={authButtonDisabled(method) || authMethodBusy(method)}
										onclick={() => onExternalProviderAction?.(provider.id)}
										style={provider.style ?? ''}
									>
										{#if provider.iconUrl}
											<img src={provider.iconUrl} alt="" class="runtime-auth-provider-icon" />
										{:else if provider.iconClass}
											<span class={provider.iconClass}></span>
										{:else}
											<span class="i-ph-globe"></span>
										{/if}
										{provider.label}
									</button>
								{/each}
							{:else}
								<button class="runtime-auth-button secondary" type="button" disabled>
									<span class="i-ph-globe"></span>
									{authWidgetLabel(field)}
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
							oninput={(event) =>
								setFieldValue(field, (event.currentTarget as HTMLInputElement).value)}
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
		{/each}
	</div>
{/if}

<style>
	.runtime-form-profile {
		display: grid;
		gap: 1rem;
	}

	.runtime-form-profile__description,
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

	.runtime-form-security {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		border: 1px solid var(--border-color, var(--border));
		border-radius: var(--radius-lg, var(--radius-md));
		background: var(--card-bg-muted, var(--surface-muted, var(--bg-glass)));
		color: var(--text-primary);
		font-weight: 600;
		padding: 1rem;
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
