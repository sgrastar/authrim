<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startRegistration } from '@simplewebauthn/browser';
	import {
		themeStore,
		LIGHT_VARIANTS,
		DARK_VARIANTS,
		type LightVariant,
		type DarkVariant,
		type ThemeVariant
	} from '$lib/stores/theme.svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { adminAuthAPI } from '$lib/api/admin-auth';
	import { myPasskeysAPI, PasskeyError, type AdminPasskey } from '$lib/api/my-passkeys';
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

	function handleLightVariant(variant: LightVariant) {
		themeStore.setLightVariant(variant);
	}

	function handleDarkVariant(variant: DarkVariant) {
		themeStore.setDarkVariant(variant);
	}

	function getThemeVariantName(variant: ThemeVariant): string {
		switch (variant) {
			case 'beige':
				return $LL.admin_account_theme_warm_beige();
			case 'blue-gray':
				return $LL.admin_account_theme_blue_gray();
			case 'green':
				return $LL.admin_account_theme_fresh_green();
			case 'brown':
				return $LL.admin_account_theme_dark_brown();
			case 'navy':
				return $LL.admin_account_theme_navy_blue();
			case 'slate':
				return $LL.admin_account_theme_slate_gray();
		}
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

<div class="admin-page">
	<!-- Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_account_heading()}</h1>
			<p class="page-description">{$LL.admin_account_description()}</p>
		</div>
	</div>

	<!-- Settings Sections -->
	<div class="settings-container">
		<!-- Security Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-shield-check"></i>
				{$LL.admin_account_security()}
			</h2>

			<div class="settings-card">
				<!-- PassKeys Header -->
				<div class="setting-row passkeys-header">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_passkeys()}</h3>
						<p class="setting-description">
							{$LL.admin_account_passkeys_desc()}
						</p>
					</div>
					<button class="add-btn" onclick={openAddModal} disabled={addingPasskey}>
						<i class="i-ph-plus"></i>
						{$LL.admin_account_add_new()}
					</button>
				</div>

				<!-- PassKeys List -->
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
							<button class="retry-btn" onclick={loadPasskeys}>
								{$LL.admin_account_retry()}
							</button>
						</div>
					{:else if passkeys.length === 0}
						<div class="passkeys-empty">
							<i class="i-ph-key"></i>
							<p>{$LL.admin_account_no_passkeys()}</p>
							<button class="add-btn-small" onclick={openAddModal}>
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
													<button class="save-btn" onclick={() => saveEditPasskey(passkey.id)}>
														{$LL.admin_account_save()}
													</button>
													<button class="cancel-btn" onclick={cancelEditPasskey}>
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
														class="confirm-yes"
														onclick={() => handleDeletePasskey(passkey.id)}
														disabled={deletingPasskeyId === passkey.id}
													>
														{#if deletingPasskeyId === passkey.id}
															<i class="i-ph-spinner spinner"></i>
														{:else}
															{$LL.admin_account_yes()}
														{/if}
													</button>
													<button class="confirm-no" onclick={cancelDeletePasskey}>
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
		</section>

		<!-- Appearance Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-paint-brush"></i>
				{$LL.admin_account_appearance()}
			</h2>

			<div class="settings-card">
				<!-- Theme Mode -->
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_theme_mode()}</h3>
						<p class="setting-description">{$LL.admin_account_theme_mode_desc()}</p>
					</div>
					<div class="theme-mode-toggle">
						<button
							class="mode-btn"
							class:active={themeStore.isLight}
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

				<!-- Theme Color Variants (shows only relevant variants based on current mode) -->
				<div class="setting-row setting-row-vertical">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_theme_color()}</h3>
						<p class="setting-description">
							{#if themeStore.isLight}
								{$LL.admin_account_light_theme_color_desc()}
							{:else}
								{$LL.admin_account_dark_theme_color_desc()}
							{/if}
						</p>
					</div>
					<div class="color-variant-options">
						{#if themeStore.isLight}
							{#each LIGHT_VARIANTS as variant (variant.id)}
								<button
									class="color-variant-btn"
									class:active={themeStore.lightVariant === variant.id}
									onclick={() => handleLightVariant(variant.id)}
									title={getThemeVariantName(variant.id)}
								>
									<span class="color-swatch" style="background: {variant.color}"></span>
									<span class="color-name">{getThemeVariantName(variant.id)}</span>
									{#if themeStore.lightVariant === variant.id}
										<i class="i-ph-check color-check"></i>
									{/if}
								</button>
							{/each}
						{:else}
							{#each DARK_VARIANTS as variant (variant.id)}
								<button
									class="color-variant-btn"
									class:active={themeStore.darkVariant === variant.id}
									onclick={() => handleDarkVariant(variant.id)}
									title={getThemeVariantName(variant.id)}
								>
									<span class="color-swatch" style="background: {variant.color}"></span>
									<span class="color-name">{getThemeVariantName(variant.id)}</span>
									{#if themeStore.darkVariant === variant.id}
										<i class="i-ph-check color-check"></i>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				</div>
			</div>
		</section>

		<!-- Language Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-translate"></i>
				{$LL.admin_account_language_region()}
			</h2>

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
		</section>

		<!-- Account Section -->
		<section class="settings-section">
			<h2 class="section-title">
				<i class="i-ph-user-circle"></i>
				{$LL.admin_account_account()}
			</h2>

			<div class="settings-card">
				<div class="setting-row">
					<div class="setting-info">
						<h3 class="setting-label">{$LL.admin_account_logged_in_as()}</h3>
						<p class="setting-description">
							{adminAuth.user?.email || $LL.admin_account_unknown()}
						</p>
					</div>
					<button class="logout-btn" onclick={handleLogout}>
						<i class="i-ph-sign-out"></i>
						{$LL.admin_account_logout()}
					</button>
				</div>
			</div>
		</section>
	</div>
</div>

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
			class="form-input"
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
		<button class="modal-btn secondary" onclick={closeAddModal} disabled={addingPasskey}>
			{$LL.common_cancel()}
		</button>
		<button class="modal-btn primary" onclick={handleAddPasskey} disabled={addingPasskey}>
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
	.settings-container {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.section-title {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.section-title :global(i) {
		width: 22px;
		height: 22px;
		color: var(--primary);
	}

	.settings-card {
		background: var(--bg-card);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-light);
		overflow: hidden;
	}

	.setting-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px 24px;
		border-bottom: 1px solid var(--border-light);
		gap: 24px;
	}

	.setting-row:last-child {
		border-bottom: none;
	}

	.setting-row-vertical {
		flex-direction: column;
		align-items: flex-start;
		gap: 16px;
	}

	.setting-info {
		flex: 1;
		min-width: 0;
	}

	.setting-label {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px 0;
	}

	.setting-description {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* PassKeys Section */
	.passkeys-header {
		border-bottom: 1px solid var(--border-light);
	}

	.passkeys-section {
		padding: 0;
	}

	.passkeys-loading,
	.passkeys-empty,
	.passkeys-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 40px 24px;
		gap: 12px;
		color: var(--text-secondary);
	}

	.passkeys-loading :global(i),
	.passkeys-empty :global(i) {
		width: 40px;
		height: 40px;
		color: var(--text-muted);
	}

	.passkeys-error {
		color: var(--danger);
	}

	.passkeys-error :global(i) {
		width: 32px;
		height: 32px;
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
		border-bottom: 1px solid var(--border-light);
	}

	.passkey-item:last-child {
		border-bottom: none;
	}

	.passkey-icon {
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
		flex-shrink: 0;
	}

	.passkey-icon :global(i) {
		width: 24px;
		height: 24px;
		color: var(--primary);
	}

	.passkey-info {
		flex: 1;
		min-width: 0;
	}

	.passkey-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px 0;
	}

	.passkey-meta {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.passkey-edit-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.passkey-name-input {
		padding: 8px 12px;
		border: 1px solid var(--border-light);
		border-radius: var(--radius-sm);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.passkey-name-input:focus {
		outline: none;
		border-color: var(--primary);
	}

	.passkey-edit-actions {
		display: flex;
		gap: 8px;
	}

	.save-btn,
	.cancel-btn {
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.save-btn {
		background: var(--primary);
		color: white;
		border: none;
	}

	.save-btn:hover {
		background: var(--primary-dark);
	}

	.cancel-btn {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-light);
	}

	.cancel-btn:hover {
		background: var(--bg-tertiary);
	}

	.passkey-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.action-btn {
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.action-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.action-btn.edit-action {
		color: var(--text-secondary);
	}

	.action-btn.edit-action:hover {
		background: var(--bg-tertiary);
		color: var(--primary);
	}

	.action-btn.delete-action {
		color: var(--text-muted);
	}

	.action-btn.delete-action:hover:not(:disabled) {
		background: rgba(220, 38, 38, 0.1);
		color: var(--danger);
	}

	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.delete-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8125rem;
	}

	.delete-confirm span {
		color: var(--danger);
		font-weight: 500;
	}

	.confirm-yes,
	.confirm-no {
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.confirm-yes {
		background: var(--danger);
		color: white;
		border: none;
	}

	.confirm-yes:hover:not(:disabled) {
		background: #b91c1c;
	}

	.confirm-yes:disabled {
		opacity: 0.7;
	}

	.confirm-no {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-light);
	}

	.confirm-no:hover {
		background: var(--bg-tertiary);
	}

	.passkeys-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 24px;
		background: var(--bg-tertiary);
		border-top: 1px solid var(--border-light);
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.passkeys-notice :global(i) {
		width: 16px;
		height: 16px;
		color: var(--info);
	}

	.add-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border: none;
		background: var(--primary);
		border-radius: var(--radius-md);
		color: white;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.add-btn:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.add-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.add-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.add-btn-small {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border: 1px solid var(--primary);
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--primary);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		margin-top: 8px;
	}

	.add-btn-small:hover {
		background: var(--primary);
		color: white;
	}

	.add-btn-small :global(i) {
		width: 16px;
		height: 16px;
	}

	.retry-btn {
		padding: 8px 16px;
		border: 1px solid var(--danger);
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--danger);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.retry-btn:hover {
		background: var(--danger);
		color: white;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.form-group label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.form-input {
		padding: 12px 16px;
		border: 1px solid var(--border-light);
		border-radius: var(--radius-md);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9375rem;
	}

	.form-input:focus {
		outline: none;
		border-color: var(--primary);
	}

	.form-input:disabled {
		opacity: 0.6;
	}

	.modal-error {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		padding: 12px;
		background: rgba(220, 38, 38, 0.1);
		border-radius: var(--radius-md);
		color: var(--danger);
		font-size: 0.8125rem;
	}

	.modal-error :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
	}

	.modal-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 20px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.modal-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.modal-btn.primary {
		background: var(--primary);
		color: white;
		border: none;
	}

	.modal-btn.primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.modal-btn.secondary {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-light);
	}

	.modal-btn.secondary:hover:not(:disabled) {
		background: var(--bg-tertiary);
	}

	.modal-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Theme Mode Toggle */
	.theme-mode-toggle {
		display: flex;
		gap: 8px;
		background: var(--bg-tertiary);
		padding: 4px;
		border-radius: var(--radius-md);
	}

	.mode-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px;
		border: none;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.mode-btn:hover {
		color: var(--text-primary);
	}

	.mode-btn.active {
		background: var(--bg-card);
		color: var(--primary);
		box-shadow: var(--shadow-sm);
	}

	.mode-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	.mode-btn :global(.mode-check) {
		color: var(--success);
		margin-left: 4px;
	}

	/* Color Variant Options - unique class names to avoid conflicts with themes.css */
	.color-variant-options {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.color-variant-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 16px 20px;
		border: 2px solid var(--border-light);
		background: var(--bg-tertiary);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all var(--transition-fast);
		min-width: 100px;
		position: relative;
	}

	.color-variant-btn:hover {
		border-color: var(--primary-light);
		background: var(--bg-card);
	}

	.color-variant-btn.active {
		border-color: var(--primary);
		background: var(--bg-card);
	}

	.color-swatch {
		display: block;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-md);
		border: 1px solid rgba(0, 0, 0, 0.1);
		flex-shrink: 0;
	}

	.color-name {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		text-align: center;
		white-space: nowrap;
	}

	.color-variant-btn.active .color-name {
		color: var(--primary);
		font-weight: 600;
	}

	.color-variant-btn :global(.color-check) {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 18px;
		height: 18px;
		color: var(--primary);
	}

	/* Language Select */
	.language-control {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
	}

	.language-select {
		padding: 10px 40px 10px 16px;
		border: 1px solid var(--border-light);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		cursor: pointer;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 12px center;
		min-width: 180px;
	}

	.language-select:focus {
		outline: none;
		border-color: var(--primary);
	}

	.language-select:disabled {
		cursor: wait;
		opacity: 0.7;
	}

	.language-error {
		margin: 0;
		color: var(--error);
		font-size: 0.8rem;
		text-align: right;
	}

	/* Logout Button */
	.logout-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 20px;
		border: 1px solid var(--danger);
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--danger);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.logout-btn:hover {
		background: var(--danger);
		color: white;
	}

	.logout-btn :global(i) {
		width: 18px;
		height: 18px;
	}

	/* Responsive */
	@media (max-width: 640px) {
		.setting-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 16px;
		}

		.passkeys-header {
			flex-direction: row;
			align-items: center;
		}

		.theme-mode-toggle,
		.color-variant-options {
			width: 100%;
		}

		.mode-btn {
			flex: 1;
			justify-content: center;
		}

		.color-variant-btn {
			flex: 1;
			min-width: 80px;
			padding: 12px 16px;
		}

		.color-swatch {
			width: 32px;
			height: 32px;
		}

		.language-select {
			width: 100%;
		}

		.logout-btn {
			width: 100%;
			justify-content: center;
		}

		.passkey-item {
			flex-wrap: wrap;
		}

		.passkey-actions {
			width: 100%;
			justify-content: flex-end;
			margin-top: 8px;
		}
	}
</style>
