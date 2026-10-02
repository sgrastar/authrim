<script module lang="ts">
	export interface DeviceInfo {
		client_name: string;
		client_uri?: string;
		logo_uri?: string;
		scopes: string[];
	}
</script>

<script lang="ts">
	/**
	 * The device-code page, as the user sees it. The route owns the state and the requests;
	 * this component only draws what it is given and reports what the user does.
	 */
	import { Button, Card, Alert } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl, isValidLinkUrl } from '$lib/utils/url-validation';

	type Props = {
		step: 'input' | 'verified';
		userCode: string;
		error?: string;
		success?: string;
		verifying?: boolean;
		loading?: boolean;
		deviceInfo?: DeviceInfo | null;
		onCodeInput: (event: Event) => void;
		onKeyPress: (event: KeyboardEvent) => void;
		onVerify: () => void;
		onApprove: () => void;
		onDeny: () => void;
		onDismissError: () => void;
	};

	let {
		step,
		userCode,
		error = '',
		success = '',
		verifying = false,
		loading = false,
		deviceInfo = null,
		onCodeInput,
		onKeyPress,
		onVerify,
		onApprove,
		onDeny,
		onDismissError
	}: Props = $props();
</script>

<Card class="mb-6">
	<!-- Icon -->
	<div class="auth-icon-badge">
		<div class="auth-icon-badge__circle">
			<div class="i-heroicons-device-phone-mobile h-9 w-9 auth-icon-badge__icon"></div>
		</div>
	</div>

	{#if step === 'input'}
		<!-- Step 1: Enter device code -->
		<h2 class="auth-section-title text-center">
			{$LL.device_title()}
		</h2>
		<p class="auth-section-subtitle text-center mb-6">
			{$LL.device_subtitle()}
		</p>

		{#if error}
			<Alert variant="error" dismissible={true} onDismiss={onDismissError} class="mb-4">
				{error}
			</Alert>
		{/if}

		<div class="mb-6">
			<label
				for="user-code"
				class="block text-sm font-medium mb-2"
				style="color: var(--text-secondary);"
			>
				{$LL.device_codeLabel()}
			</label>
			<input
				id="user-code"
				type="text"
				class="auth-code-input"
				placeholder={$LL.device_codePlaceholder()}
				maxlength="9"
				value={userCode}
				oninput={onCodeInput}
				onkeypress={onKeyPress}
				autocomplete="off"
				spellcheck="false"
				aria-describedby="device-code-hint"
			/>
			<p id="device-code-hint" class="text-xs text-center mt-2" style="color: var(--text-muted);">
				{$LL.device_codeHint()}
			</p>
		</div>

		<Button
			variant="primary"
			class="w-full"
			loading={verifying}
			disabled={userCode.replace(/-/g, '').length !== 8}
			onclick={onVerify}
		>
			{$LL.device_verifyButton()}
		</Button>
	{:else if step === 'verified'}
		<!-- Step 2: Approve/Deny device -->
		<h2 class="auth-section-title text-center">
			{$LL.device_confirmTitle()}
		</h2>

		{#if success}
			<Alert variant="success" class="mt-4">
				{success}
			</Alert>
		{:else}
			{#if error}
				<Alert variant="error" dismissible={true} onDismiss={onDismissError} class="mt-4 mb-4">
					{error}
				</Alert>
			{/if}

			{#if deviceInfo}
				<div class="auth-info-box mt-6 mb-6">
					<div class="flex items-center gap-3 mb-3">
						{#if deviceInfo.logo_uri && isValidImageUrl(deviceInfo.logo_uri)}
							<img
								src={deviceInfo.logo_uri}
								alt={deviceInfo.client_name}
								class="h-10 w-10 rounded-lg"
							/>
						{/if}
						<div>
							<p class="auth-info-box__value">
								{deviceInfo.client_name}
							</p>
							{#if deviceInfo.client_uri && isValidLinkUrl(deviceInfo.client_uri)}
								<a
									href={deviceInfo.client_uri}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs"
									style="color: var(--primary);"
								>
									{deviceInfo.client_uri}
								</a>
							{/if}
						</div>
					</div>

					{#if deviceInfo.scopes && deviceInfo.scopes.length > 0}
						<p class="auth-info-box__label mb-2">
							{$LL.device_requestedPermissions()}
						</p>
						<ul class="auth-scopes-list">
							{#each deviceInfo.scopes as scope (scope)}
								<li>
									<div class="i-heroicons-check-circle h-4 w-4 auth-scopes-list__icon"></div>
									{scope}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			<div class="auth-actions">
				<Button variant="secondary" class="flex-1" disabled={loading} onclick={onDeny}>
					{$LL.device_denyButton()}
				</Button>
				<Button variant="primary" class="flex-1" {loading} onclick={onApprove}>
					{$LL.device_approveButton()}
				</Button>
			</div>
		{/if}
	{/if}
</Card>

<!-- Back to Home -->
<p class="auth-bottom-link">
	<a href="/">
		{$LL.common_backToHome()}
	</a>
</p>
