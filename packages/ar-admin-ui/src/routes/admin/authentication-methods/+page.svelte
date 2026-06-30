<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAuthenticationMethodsAPI,
		type AuthenticationMethodBuiltInSettings,
		type AuthenticationMethodDirectoryPasswordSettings,
		type AuthenticationMethodExternalProviderUsage,
		type AuthenticationMethodHumanVerificationSettings
	} from '$lib/api/admin-authentication-methods';
	import type { CategorySettings } from '$lib/api/admin-settings';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	const DEFAULT_BUILT_IN: AuthenticationMethodBuiltInSettings = {
		passkeyLoginEnabled: true,
		passkeySignupEnabled: true,
		passkeyReauthEnabled: true,
		passkeyAccountLinkEnabled: true,
		emailOtpLoginEnabled: true,
		emailOtpSignupEnabled: true,
		emailOtpReauthEnabled: true,
		emailOtpAccountLinkEnabled: true
	};
	const DEFAULT_DIRECTORY_PASSWORD: AuthenticationMethodDirectoryPasswordSettings = {
		loginEnabled: false,
		configured: false,
		connectorCount: 0,
		defaultConnectorId: 'campus',
		autoProvision: false,
		config: null
	};
	const DEFAULT_HUMAN_VERIFICATION: AuthenticationMethodHumanVerificationSettings = {
		provider: 'human-verification-cloudflare-turnstile',
		loginEnabled: false,
		signupEnabled: false,
		reauthEnabled: false
	};

	type Usage = 'signup' | 'login' | 'reauth' | 'account_link';

	let loading = $state(true);
	let error = $state('');
	let settings = $state<CategorySettings | null>(null);
	let builtIn = $state<AuthenticationMethodBuiltInSettings>({ ...DEFAULT_BUILT_IN });
	let directoryPassword = $state<AuthenticationMethodDirectoryPasswordSettings>({
		...DEFAULT_DIRECTORY_PASSWORD
	});
	let humanVerification = $state<AuthenticationMethodHumanVerificationSettings>({
		...DEFAULT_HUMAN_VERIFICATION
	});
	let externalProviderUsages = $state<AuthenticationMethodExternalProviderUsage[]>([]);

	const currentTenantId = $derived(settingsContext.tenantId);
	const loginMethods = $derived(enabledMethods('login'));
	const signupMethods = $derived(enabledMethods('signup'));
	const reauthMethods = $derived(enabledMethods('reauth'));
	const accountLinkMethods = $derived(enabledMethods('account_link'));

	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	let previousTenantId = $state('');
	$effect(() => {
		if (!currentTenantId || loading) return;
		if (previousTenantId === currentTenantId) return;
		previousTenantId = currentTenantId;
		if (settings) {
			loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';
		try {
			const response = await adminAuthenticationMethodsAPI.get(currentTenantId);
			settings = response.settings;
			builtIn = response.builtIn;
			directoryPassword = response.directoryPassword;
			humanVerification = response.humanVerification;
			externalProviderUsages = response.externalProviderUsages;
		} catch (err) {
			error = err instanceof Error ? err.message : '認証方式プロフィールの読み込みに失敗しました。';
		} finally {
			loading = false;
		}
	}

	function enabledMethods(usage: Usage): string[] {
		const labels: string[] = [];
		if (usage === 'signup' && builtIn.passkeySignupEnabled) labels.push('Passkey');
		if (usage === 'login' && builtIn.passkeyLoginEnabled) labels.push('Passkey');
		if (usage === 'reauth' && builtIn.passkeyReauthEnabled) labels.push('Passkey');
		if (usage === 'account_link' && builtIn.passkeyAccountLinkEnabled) labels.push('Passkey');

		if (usage === 'signup' && builtIn.emailOtpSignupEnabled) labels.push('Mail OTP');
		if (usage === 'login' && builtIn.emailOtpLoginEnabled) labels.push('Mail OTP');
		if (usage === 'reauth' && builtIn.emailOtpReauthEnabled) labels.push('Mail OTP');
		if (usage === 'account_link' && builtIn.emailOtpAccountLinkEnabled) labels.push('Mail OTP');

		if (usage === 'login' && directoryPassword.loginEnabled) {
			labels.push('Directory password');
		}

		for (const provider of externalProviderUsages) {
			if (!provider.enabled) continue;
			if (usage === 'signup' && provider.signupEnabled) labels.push(provider.name);
			if (usage === 'login' && provider.loginEnabled) labels.push(provider.name);
			if (usage === 'reauth' && provider.reauthEnabled) labels.push(provider.name);
			if (usage === 'account_link' && provider.accountLinkEnabled) labels.push(provider.name);
		}
		return labels;
	}

	function formatMethodList(methods: string[]): string {
		if (methods.length === 0) return 'なし';
		return methods.slice(0, 3).join(', ') + (methods.length > 3 ? ` +${methods.length - 3}` : '');
	}

	function humanVerificationSummary(): string {
		const enabled: string[] = [];
		if (humanVerification.signupEnabled) enabled.push('登録');
		if (humanVerification.loginEnabled) enabled.push('ログイン');
		if (humanVerification.reauthEnabled) enabled.push('再認証');
		return enabled.length > 0 ? enabled.join(', ') : '無効';
	}
</script>

<svelte:head>
	<title>認証方式プロフィール - Admin Dashboard - Authrim</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title="認証方式プロフィール"
		description={`ログイン、登録、再認証、アカウント連携で使う認証方式のプロフィールを管理します。現在のテナント: ${currentTenantId || '-'}`}
	>
		{#snippet actions()}
			<span class="cache-notice">変更がLoginUIに反映されるまで最大3分かかる場合があります。</span>
		{/snippet}
	</AdminPageHeader>

	{#if loading}
		<AdminSection>
			<div class="state">読み込み中...</div>
		</AdminSection>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}

		<AdminSection
			title="Profiles"
			description="Flowではここで定義したプロフィールを選択します。認証方式の細かい有効/無効はプロフィール詳細で管理します。"
		>
			<div class="profile-grid">
				<a class="profile-card" href="/admin/authentication-methods/default">
					<div class="profile-card__header">
						<div>
							<p class="profile-card__eyebrow">Built-in</p>
							<h2>Default profile</h2>
						</div>
						<span class="status-badge">Default</span>
					</div>
					<p class="profile-card__description">
						既存の認証方式設定です。Flowから選択するDefault profileとして扱います。
					</p>
					<div class="profile-card__matrix">
						<div>
							<span>登録</span>
							<strong>{formatMethodList(signupMethods)}</strong>
						</div>
						<div>
							<span>ログイン</span>
							<strong>{formatMethodList(loginMethods)}</strong>
						</div>
						<div>
							<span>再認証</span>
							<strong>{formatMethodList(reauthMethods)}</strong>
						</div>
						<div>
							<span>連携</span>
							<strong>{formatMethodList(accountLinkMethods)}</strong>
						</div>
					</div>
					<div class="profile-card__footer">
						<span>Human verification: {humanVerificationSummary()}</span>
						<i class="i-ph-arrow-right" aria-hidden="true"></i>
					</div>
				</a>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.cache-notice {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.35;
		white-space: nowrap;
	}

	.profile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 14px;
	}

	.profile-card {
		display: grid;
		gap: 14px;
		padding: 18px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		text-decoration: none;
		box-shadow: var(--card-shadow, none);
		transition:
			border-color 120ms ease,
			transform 120ms ease,
			background 120ms ease;
	}

	.profile-card:hover {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface));
		transform: translateY(-1px);
	}

	.profile-card__header,
	.profile-card__footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.profile-card__eyebrow {
		margin: 0 0 4px;
		color: var(--color-accent);
		font-size: 0.66rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.profile-card h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.12rem;
		line-height: 1.25;
	}

	.profile-card__description {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.84rem;
		line-height: 1.55;
	}

	.profile-card__matrix {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.profile-card__matrix div {
		display: grid;
		gap: 4px;
		min-height: 62px;
		padding: 10px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface-muted);
	}

	.profile-card__matrix span,
	.profile-card__footer {
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}

	.profile-card__matrix strong {
		color: var(--color-text);
		font-size: 0.84rem;
		line-height: 1.35;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 9px;
		border: 1px solid color-mix(in srgb, var(--color-success) 40%, var(--color-border));
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		color: var(--color-success);
		font-size: 0.72rem;
		font-weight: 850;
	}

	.alert {
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 14px;
	}

	.alert-error {
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.state {
		padding: 14px 16px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	@media (max-width: 640px) {
		.profile-grid,
		.profile-card__matrix {
			grid-template-columns: 1fr;
		}
	}
</style>
