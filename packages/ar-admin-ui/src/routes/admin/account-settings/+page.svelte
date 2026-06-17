<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startRegistration } from '@simplewebauthn/browser';
	import { ADMIN_SKINS, themeStore, type AdminSkin } from '$lib/stores/theme.svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { adminAuthAPI } from '$lib/api/admin-auth';
	import { myPasskeysAPI, PasskeyError, type AdminPasskey } from '$lib/api/my-passkeys';
	import { formatAdminSkinDescription, formatAdminSkinName } from '$lib/admin/admin-skins-i18n';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { Modal } from '$lib/components';
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import { LOCALE_LABELS, SUPPORTED_LOCALES, isSupportedLocale } from '$i18n/locales';
	import type { Locales } from '$i18n/i18n-types';

	// State
	let selectedLanguage = $state<Locales>(getLocale());
	let languageSaving = $state(false);
	let languageError = $state('');

	// PassKey state
	let passkeys = $state<AdminPasskey[]>([]);
	let passkeysLoading = $state(true);
	let passkeysError = $state('');
	let addingPasskey = $state(false);
	let deletingPasskeyId = $state<string | null>(null);
	let editingPasskeyId = $state<string | null>(null);
	let editDeviceName = $state('');
	let showAddModal = $state(false);
	let newDeviceName = $state('');
	let showDeleteConfirm = $state<string | null>(null);

	function handleSkin(skin: AdminSkin) {
		themeStore.setSkin(skin);
	}

	function getLanguageName(language: Locales): string {
		const label = language === 'en' ? $LL.language_english() : $LL.language_japanese();
		const nativeName = LOCALE_LABELS[language].nativeName;
		return nativeName === label ? label : `${label} (${nativeName})`;
	}

	async function handleLanguageChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		const nextLanguage = target.value;
		const previousLanguage = selectedLanguage;

		if (!isSupportedLocale(nextLanguage)) {
			target.value = previousLanguage;
			return;
		}

		if (nextLanguage === selectedLanguage) {
			return;
		}

		selectedLanguage = nextLanguage;
		languageSaving = true;
		languageError = '';

		try {
			const response = await fetch('/api/set-language', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ language: nextLanguage })
			});

			if (!response.ok) {
				throw new Error('Failed to update language');
			}

			setLocale(nextLanguage);
			window.location.reload();
		} catch {
			selectedLanguage = previousLanguage;
			target.value = previousLanguage;
			languageError = $LL.language_switch_error();
		} finally {
			languageSaving = false;
		}
	}

	async function handleLogout() {
		adminAuth.clearAuth();
		await adminAuthAPI.logout();
		goto('/admin/login');
	}

	// PassKey functions
	async function loadPasskeys() {
		passkeysLoading = true;
		passkeysError = '';
		try {
			const response = await myPasskeysAPI.list();
			passkeys = response.passkeys;
		} catch (error) {
			passkeysError = getLocalizedPasskeyErrorMessage(error);
		} finally {
			passkeysLoading = false;
		}
	}

	function openAddModal() {
		newDeviceName = '';
		showAddModal = true;
	}

	function closeAddModal() {
		showAddModal = false;
		newDeviceName = '';
	}

	async function handleAddPasskey() {
		if (!newDeviceName.trim()) {
			passkeysError = $LL.admin_account_device_name_required();
			return;
		}

		addingPasskey = true;
		passkeysError = '';

		try {
			const rpId = window.location.hostname;
			const origin = window.location.origin;

			// Step 1: Get registration options
			const { options, challenge_id } = await myPasskeysAPI.getRegistrationOptions(
				rpId,
				newDeviceName.trim()
			);

			// Step 2: Start registration (browser native WebAuthn)
			const credential = await startRegistration({ optionsJSON: options });

			// Step 3: Complete registration
			const result = await myPasskeysAPI.completeRegistration(
				challenge_id,
				credential,
				origin,
				newDeviceName.trim()
			);

			if (result.success) {
				// Add the new passkey to the list
				passkeys = [result.passkey, ...passkeys];
				closeAddModal();
			}
		} catch (error) {
			passkeysError = getLocalizedPasskeyErrorMessage(error);
		} finally {
			addingPasskey = false;
		}
	}

	function startEditPasskey(passkey: AdminPasskey) {
		editingPasskeyId = passkey.id;
		editDeviceName = passkey.device_name || '';
	}

	function cancelEditPasskey() {
		editingPasskeyId = null;
		editDeviceName = '';
	}

	async function saveEditPasskey(passkeyId: string) {
		if (!editDeviceName.trim()) {
			passkeysError = $LL.admin_account_device_name_empty();
			return;
		}

		passkeysError = '';

		try {
			const result = await myPasskeysAPI.updateDeviceName(passkeyId, editDeviceName.trim());
			if (result.success) {
				// Update the passkey in the list
				passkeys = passkeys.map((pk) =>
					pk.id === passkeyId ? { ...pk, device_name: editDeviceName.trim() } : pk
				);
				editingPasskeyId = null;
				editDeviceName = '';
			}
		} catch (error) {
			passkeysError = getLocalizedPasskeyErrorMessage(error);
		}
	}

	function confirmDeletePasskey(passkeyId: string) {
		showDeleteConfirm = passkeyId;
	}

	function cancelDeletePasskey() {
		showDeleteConfirm = null;
	}

	async function handleDeletePasskey(passkeyId: string) {
		deletingPasskeyId = passkeyId;
		passkeysError = '';

		try {
			await myPasskeysAPI.delete(passkeyId);
			// Remove the passkey from the list
			passkeys = passkeys.filter((pk) => pk.id !== passkeyId);
			showDeleteConfirm = null;
		} catch (error) {
			passkeysError = getLocalizedPasskeyErrorMessage(error);
		} finally {
			deletingPasskeyId = null;
		}
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return $LL.common_never();
		const date = new Date(timestamp);
		return date.toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatRelativeTime(timestamp: number | null): string {
		if (!timestamp) return $LL.common_never();

		const now = Date.now();
		const diff = now - timestamp;

		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return $LL.common_just_now();
		if (minutes < 60) return $LL.common_minutes_ago({ count: minutes });
		if (hours < 24) return $LL.common_hours_ago({ count: hours });
		if (days < 7) return $LL.common_days_ago({ count: days });

		return formatDate(timestamp);
	}

	function getLocalizedPasskeyErrorMessage(error: unknown): string {
		if (error instanceof PasskeyError) {
			switch (error.code) {
				case 'invalid_challenge':
					return $LL.admin_account_registration_expired();
				case 'verification_failed':
					return $LL.admin_account_verification_failed();
				case 'credential_exists':
					return $LL.admin_account_credential_exists();
				case 'last_passkey':
					return $LL.admin_account_last_passkey_error();
				case 'invalid_request':
					return $LL.admin_account_invalid_request();
				default:
					return $LL.admin_account_generic_error();
			}
		}

		if (error instanceof Error) {
			if (error.name === 'NotAllowedError') {
				return $LL.admin_account_webauthn_cancelled();
			}
			if (error.name === 'NotSupportedError') {
				return $LL.admin_account_webauthn_not_supported();
			}
			if (error.name === 'SecurityError') {
				return $LL.admin_account_webauthn_security_error();
			}
			if (error.name === 'InvalidStateError') {
				return $LL.admin_account_webauthn_already_registered();
			}
		}

		return $LL.admin_account_unexpected_error();
	}

	onMount(() => {
		// Theme is already initialized in +layout.svelte
		selectedLanguage = getLocale();
		loadPasskeys();
	});
</script>

<svelte:head>
	<title>{$LL.admin_account_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_account_heading()}
		description={$LL.admin_account_description()}
	/>

	<div class="settings-stack">
		<AdminSection title={$LL.admin_account_security()}>
			<div class="settings-card">
				<div class="setting-row passkeys-header">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_passkeys()}</h3>
						<p class="setting-description">
							{$LL.admin_account_passkeys_desc()}
						</p>
					</div>
					<button class="btn btn-primary" onclick={openAddModal} disabled={addingPasskey}>
						<i class="i-ph-plus"></i>
						{$LL.admin_account_add_new()}
					</button>
				</div>

				<div class="passkeys-section">
					{#if passkeysLoading}
						<div class="passkeys-loading">
							<i class="i-ph-spinner spinner"></i>
							<span>{$LL.admin_account_loading_passkeys()}</span>
						</div>
					{:else if passkeysError}
						<div class="passkeys-error">
							<i class="i-ph-warning-circle"></i>
							<span>{passkeysError}</span>
							<button class="btn btn-secondary btn-sm" onclick={loadPasskeys}>
								{$LL.admin_account_retry()}
							</button>
						</div>
					{:else if passkeys.length === 0}
						<div class="passkeys-empty">
							<i class="i-ph-key"></i>
							<p>{$LL.admin_account_no_passkeys()}</p>
							<button class="btn btn-secondary btn-sm" onclick={openAddModal}>
								<i class="i-ph-plus"></i>
								{$LL.admin_account_add_first_passkey()}
							</button>
						</div>
					{:else}
						<div class="passkeys-list">
							{#each passkeys as passkey (passkey.id)}
								<div class="passkey-item">
									<div class="passkey-icon">
										<i class="i-ph-key"></i>
									</div>
									<div class="passkey-info">
										{#if editingPasskeyId === passkey.id}
											<div class="passkey-edit-form">
												<input
													type="text"
													class="passkey-name-input"
													bind:value={editDeviceName}
													placeholder={$LL.admin_account_device_name_placeholder()}
													maxlength="100"
												/>
												<div class="passkey-edit-actions">
													<button
														class="btn btn-primary btn-sm"
														onclick={() => saveEditPasskey(passkey.id)}
													>
														{$LL.admin_account_save()}
													</button>
													<button class="btn btn-secondary btn-sm" onclick={cancelEditPasskey}>
														{$LL.common_cancel()}
													</button>
												</div>
											</div>
										{:else}
											<h4 class="passkey-name">
												{passkey.device_name || $LL.admin_account_unnamed_passkey()}
											</h4>
											<p class="passkey-meta">
												{$LL.admin_account_passkey_meta({
													created: formatDate(passkey.created_at),
													lastUsed: formatRelativeTime(passkey.last_used_at)
												})}
											</p>
										{/if}
									</div>
									{#if editingPasskeyId !== passkey.id}
										<div class="passkey-actions">
											{#if showDeleteConfirm === passkey.id}
												<div class="delete-confirm">
													<span>{$LL.admin_account_delete_prompt()}</span>
													<button
														class="btn btn-danger btn-sm"
														onclick={() => handleDeletePasskey(passkey.id)}
														disabled={deletingPasskeyId === passkey.id}
													>
														{#if deletingPasskeyId === passkey.id}
															<i class="i-ph-spinner spinner"></i>
														{:else}
															{$LL.admin_account_yes()}
														{/if}
													</button>
													<button class="btn btn-secondary btn-sm" onclick={cancelDeletePasskey}>
														{$LL.admin_account_no()}
													</button>
												</div>
											{:else}
												<button
													class="action-btn edit-action"
													onclick={() => startEditPasskey(passkey)}
													title={$LL.admin_account_edit_device_name()}
												>
													<i class="i-ph-pencil-simple"></i>
												</button>
												<button
													class="action-btn delete-action"
													onclick={() => confirmDeletePasskey(passkey.id)}
													title={$LL.admin_account_delete_passkey()}
													disabled={passkeys.length <= 1}
												>
													<i class="i-ph-trash"></i>
												</button>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
						{#if passkeys.length === 1}
							<div class="passkeys-notice">
								<i class="i-ph-info"></i>
								<span>{$LL.admin_account_one_passkey_notice()}</span>
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</AdminSection>

		<AdminSection title={$LL.admin_account_appearance()}>
			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_theme_mode()}</h3>
						<p class="setting-description">{$LL.admin_account_theme_mode_desc()}</p>
					</div>
					<div class="theme-mode-toggle">
						<button
							class="mode-btn"
							class:active={themeStore.isLight}
							data-mode="light"
							aria-pressed={themeStore.isLight}
							onclick={() => themeStore.setMode('light')}
						>
							<i class="i-ph-sun"></i>
							<span>{$LL.admin_account_light()}</span>
							{#if themeStore.isLight}
								<i class="i-ph-check-circle-fill mode-check"></i>
							{/if}
						</button>
						<button
							class="mode-btn"
							class:active={themeStore.isDark}
							data-mode="dark"
							aria-pressed={themeStore.isDark}
							onclick={() => themeStore.setMode('dark')}
						>
							<i class="i-ph-moon"></i>
							<span>{$LL.admin_account_dark()}</span>
							{#if themeStore.isDark}
								<i class="i-ph-check-circle-fill mode-check"></i>
							{/if}
						</button>
					</div>
				</div>

				<div class="setting-row setting-row-vertical">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_theme_color()}</h3>
						<p class="setting-description">
							{$LL.admin_account_light_theme_color_desc()}
						</p>
					</div>
					<div class="skin-options">
						{#each ADMIN_SKINS as skin (skin.id)}
							<button
								class="skin-option-btn"
								class:active={themeStore.skin === skin.id}
								data-skin={skin.id}
								aria-pressed={themeStore.skin === skin.id}
								onclick={() => handleSkin(skin.id)}
								title={formatAdminSkinDescription(skin.id, $LL)}
							>
								<span class="skin-swatch" data-skin={skin.id}></span>
								<span class="skin-name">{formatAdminSkinName(skin.id, $LL)}</span>
								<span class="skin-desc">{formatAdminSkinDescription(skin.id, $LL)}</span>
								{#if themeStore.skin === skin.id}
									<i class="i-ph-check color-check"></i>
								{/if}
							</button>
						{/each}
					</div>
				</div>
			</div>
		</AdminSection>

		<AdminSection title={$LL.admin_account_language_region()}>
			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_interface_language()}</h3>
						<p class="setting-description">
							{$LL.admin_account_interface_language_desc()}
						</p>
					</div>
					<div class="language-control">
						<select
							class="language-select"
							value={selectedLanguage}
							onchange={handleLanguageChange}
							disabled={languageSaving}
							aria-label={$LL.language_select_label()}
							aria-invalid={languageError ? 'true' : undefined}
						>
							{#each SUPPORTED_LOCALES as lang (lang)}
								<option value={lang}>
									{getLanguageName(lang)}
								</option>
							{/each}
						</select>
						{#if languageError}
							<p class="language-error" role="alert">{languageError}</p>
						{/if}
					</div>
				</div>
			</div>
		</AdminSection>

		<AdminSection title={$LL.admin_account_account()}>
			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_logged_in_as()}</h3>
						<p class="setting-description">
							{adminAuth.user?.email || $LL.admin_account_unknown()}
						</p>
					</div>
					<button class="btn btn-danger" onclick={handleLogout}>
						<i class="i-ph-sign-out"></i>
						{$LL.admin_account_logout()}
					</button>
				</div>
			</div>
		</AdminSection>
	</div>
</AdminPageShell>

<!-- Add PassKey Modal -->
<Modal
	open={showAddModal}
	onClose={closeAddModal}
	title={$LL.admin_account_add_passkey_title()}
	size="md"
>
	<p class="modal-description">
		{$LL.admin_account_add_passkey_desc()}
	</p>
	<div class="form-group">
		<label for="device-name">{$LL.admin_account_device_name()}</label>
		<input
			id="device-name"
			type="text"
			class="admin-input"
			bind:value={newDeviceName}
			placeholder={$LL.admin_account_device_name_example_placeholder()}
			maxlength="100"
			disabled={addingPasskey}
		/>
	</div>
	{#if passkeysError}
		<div class="modal-error">
			<i class="i-ph-warning-circle"></i>
			{passkeysError}
		</div>
	{/if}
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeAddModal} disabled={addingPasskey}>
			{$LL.common_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleAddPasskey} disabled={addingPasskey}>
			{#if addingPasskey}
				<i class="i-ph-spinner spinner"></i>
				{$LL.admin_account_registering()}
			{:else}
				<i class="i-ph-fingerprint"></i>
				{$LL.admin_account_register_passkey()}
			{/if}
		</button>
	{/snippet}
</Modal>

<style>
	.settings-stack {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.settings-card {
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-panel, none));
	}

	.setting-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		padding: 20px 24px;
		border-bottom: 1px solid var(--color-border);
	}

	.setting-row:last-child {
		border-bottom: none;
	}

	.setting-row-vertical {
		align-items: stretch;
		flex-direction: column;
		gap: 16px;
	}

	.setting-info {
		min-width: 0;
		flex: 1;
	}

	.setting-label {
		margin: 0 0 4px;
		color: var(--color-text);
		font-size: 0.94rem;
		font-weight: 700;
		line-height: 1.35;
	}

	.setting-description,
	.passkey-meta {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.55;
	}

	.passkeys-loading,
	.passkeys-empty,
	.passkeys-error {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 12px;
		min-height: 180px;
		padding: 40px 24px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.passkeys-loading :global(i),
	.passkeys-empty :global(i) {
		width: 40px;
		height: 40px;
		color: var(--color-text-subtle);
	}

	.passkeys-error {
		color: var(--color-danger);
	}

	.spinner {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.passkeys-list {
		display: flex;
		flex-direction: column;
	}

	.passkey-item {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 24px;
		border-bottom: 1px solid var(--color-border);
	}

	.passkey-item:last-child {
		border-bottom: none;
	}

	.passkey-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		flex-shrink: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.passkey-icon :global(i) {
		width: 24px;
		height: 24px;
		color: var(--color-accent);
	}

	.passkey-info {
		min-width: 0;
		flex: 1;
	}

	.passkey-name {
		margin: 0 0 4px;
		color: var(--color-text);
		font-size: 0.94rem;
		font-weight: 700;
		line-height: 1.35;
	}

	.passkey-edit-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.passkey-name-input {
		width: 100%;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.passkey-name-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.passkey-edit-actions,
	.passkey-actions,
	.delete-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		transition:
			background 0.16s ease,
			border-color 0.16s ease,
			color 0.16s ease;
	}

	.action-btn:hover:not(:disabled) {
		border-color: var(--color-border);
		background: var(--color-surface-muted);
		color: var(--color-accent);
	}

	.action-btn.delete-action:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.action-btn:disabled {
		cursor: not-allowed;
		opacity: 0.42;
	}

	.action-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.delete-confirm {
		justify-content: flex-end;
		color: var(--color-danger);
		font-size: 0.82rem;
		font-weight: 700;
	}

	.passkeys-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 24px;
		border-top: 1px solid var(--color-border);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.passkeys-notice :global(i) {
		width: 16px;
		height: 16px;
		color: var(--color-accent);
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.form-group label {
		color: var(--color-text);
		font-size: 0.82rem;
		font-weight: 700;
	}

	.modal-description {
		margin: 0 0 16px;
		color: var(--color-text-muted);
		font-size: 0.9rem;
		line-height: 1.6;
	}

	.modal-error {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, transparent);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
		font-size: 0.82rem;
	}

	.theme-mode-toggle {
		display: flex;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.mode-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--control-height, 40px);
		padding: 8px 14px;
		border: 1px solid transparent;
		border-radius: calc(var(--radius-control) - 1px);
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 0.86rem;
		font-weight: 700;
		cursor: pointer;
	}

	.mode-btn:hover {
		color: var(--color-text);
	}

	.mode-btn.active {
		border-color: var(--color-border);
		background: var(--color-surface);
		color: var(--color-accent);
		box-shadow: var(--shadow-sm, none);
	}

	.mode-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.mode-btn :global(.mode-check) {
		color: var(--color-success);
	}

	.skin-options {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.skin-option-btn {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-areas:
			'swatch name'
			'swatch desc';
		align-items: center;
		gap: 4px 12px;
		min-width: 0;
		padding: 14px 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
		color: var(--color-text);
		text-align: left;
		cursor: pointer;
		transition:
			background 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.skin-option-btn:hover {
		border-color: var(--color-accent);
		background: var(--color-surface);
	}

	.skin-option-btn.active {
		border-color: var(--color-accent);
		background: var(--color-surface);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.skin-swatch {
		grid-area: swatch;
		display: block;
		width: 42px;
		height: 42px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
	}

	.skin-swatch[data-skin='classic'] {
		background: linear-gradient(135deg, #f9f8f3 0%, #234168 62%, #b58b3b 100%);
	}

	.skin-swatch[data-skin='admin'] {
		background: linear-gradient(135deg, #f6f5f1 0%, #141412 56%, #c7512f 100%);
	}

	.skin-swatch[data-skin='paper-beige'] {
		background: linear-gradient(135deg, #f5f1e7 0%, #25332d 58%, #2f7a5a 100%);
	}

	.skin-swatch[data-skin='frosted'] {
		background: linear-gradient(135deg, #eef3ff 0%, #d6e2ff 48%, #5b6ee1 100%);
	}

	.skin-name {
		grid-area: name;
		color: var(--color-text);
		font-size: 0.875rem;
		font-weight: 800;
		line-height: 1.3;
	}

	.skin-desc {
		grid-area: desc;
		color: var(--color-text-muted);
		font-size: 0.74rem;
		line-height: 1.45;
	}

	.skin-option-btn.active .skin-name,
	.skin-option-btn :global(.color-check) {
		color: var(--color-accent);
	}

	.skin-option-btn :global(.color-check) {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 18px;
		height: 18px;
	}

	.language-control {
		display: flex;
		align-items: flex-end;
		flex-direction: column;
		gap: 8px;
	}

	.language-select {
		min-width: 180px;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
	}

	.language-select:focus {
		border-color: var(--color-accent);
		outline: none;
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.language-select:disabled {
		cursor: wait;
		opacity: 0.7;
	}

	.language-error {
		margin: 0;
		color: var(--color-danger);
		font-size: 0.8rem;
		text-align: right;
	}

	@media (max-width: 720px) {
		.setting-row {
			align-items: flex-start;
			flex-direction: column;
			gap: 16px;
		}

		.passkeys-header {
			align-items: center;
			flex-direction: row;
		}

		.theme-mode-toggle,
		.skin-options,
		.language-control,
		.language-select {
			width: 100%;
		}

		.mode-btn {
			justify-content: center;
			flex: 1 1 0;
		}

		.skin-options {
			grid-template-columns: 1fr;
		}

		.skin-option-btn {
			padding: 12px 14px;
		}

		.skin-swatch {
			width: 34px;
			height: 34px;
		}

		.passkey-item {
			align-items: flex-start;
			flex-wrap: wrap;
		}

		.passkey-actions {
			width: 100%;
			justify-content: flex-end;
			margin-top: 8px;
		}
	}
</style>
