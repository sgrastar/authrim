<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Card, Button, Input } from '$lib/components';
	import { onMount } from 'svelte';
	import { adminSettingsAPI } from '$lib/api/client';

	type Tab = 'general' | 'appearance' | 'security' | 'email' | 'advanced' | 'ciba';

	let activeTab: Tab = 'general';
	let loading = false;
	let saving = false;
	let error = '';
	let successMessage = '';

	// General settings
	let siteName = 'Authrim';
	let logoUrl = '';
	let language = 'en';
	let timezone = 'UTC';

	// Appearance settings
	let primaryColor = '#3B82F6';
	let secondaryColor = '#10B981';
	let fontFamily = 'Inter';

	// Security settings
	let sessionTimeout = 86400; // 24 hours in seconds
	let mfaEnforced = false;
	let passwordMinLength = 8;
	let passwordRequireSpecialChar = true;

	// Email settings
	let emailProvider: 'resend' | 'cloudflare' | 'smtp' = 'resend';
	let smtpHost = '';
	let smtpPort = 587;
	let smtpUsername = '';
	let smtpPassword = '';

	// Advanced settings
	let accessTokenTtl = 3600; // 1 hour in seconds
	let idTokenTtl = 3600; // 1 hour in seconds
	let refreshTokenTtl = 2592000; // 30 days in seconds
	let passkeyEnabled = true;
	let magicLinkEnabled = true;

	// CIBA settings
	let cibaEnabled = true;
	let cibaDefaultExpiresIn = 300; // 5 minutes
	let cibaMinExpiresIn = 60; // 1 minute
	let cibaMaxExpiresIn = 600; // 10 minutes
	let cibaDefaultInterval = 5; // 5 seconds
	let cibaMinInterval = 2; // 2 seconds
	let cibaMaxInterval = 60; // 60 seconds
	let cibaSupportedDeliveryModes: string[] = ['poll', 'ping', 'push'];
	let cibaUserCodeEnabled = true;
	let cibaBindingMessageMaxLength = 140;
	let cibaNotificationsEnabled = false;
	let cibaNotificationEmail = false;
	let cibaNotificationSms = false;
	let cibaNotificationPush = false;

	onMount(async () => {
		await loadSettings();
	});

	async function loadSettings() {
		loading = true;
		error = '';

		try {
			const { data, error: apiError } = await adminSettingsAPI.get();

			if (apiError) {
				error = apiError.error_description || 'Failed to load settings';
				console.error('Failed to load settings:', apiError);
			} else if (data) {
				// General
				siteName = data.settings.general.siteName;
				logoUrl = data.settings.general.logoUrl;
				language = data.settings.general.language;
				timezone = data.settings.general.timezone;

				// Appearance
				primaryColor = data.settings.appearance.primaryColor;
				secondaryColor = data.settings.appearance.secondaryColor;
				fontFamily = data.settings.appearance.fontFamily;

				// Security
				sessionTimeout = data.settings.security.sessionTimeout;
				mfaEnforced = data.settings.security.mfaEnforced;
				passwordMinLength = data.settings.security.passwordMinLength;
				passwordRequireSpecialChar = data.settings.security.passwordRequireSpecialChar;

				// Email
				emailProvider = data.settings.email.emailProvider;
				smtpHost = data.settings.email.smtpHost;
				smtpPort = data.settings.email.smtpPort;
				smtpUsername = data.settings.email.smtpUsername;
				smtpPassword = data.settings.email.smtpPassword;

				// Advanced
				accessTokenTtl = data.settings.advanced.accessTokenTtl;
				idTokenTtl = data.settings.advanced.idTokenTtl;
				refreshTokenTtl = data.settings.advanced.refreshTokenTtl;
				passkeyEnabled = data.settings.advanced.passkeyEnabled;
				magicLinkEnabled = data.settings.advanced.magicLinkEnabled;

				// CIBA
				if (data.settings.ciba) {
					cibaEnabled = data.settings.ciba.enabled;
					cibaDefaultExpiresIn = data.settings.ciba.defaultExpiresIn;
					cibaMinExpiresIn = data.settings.ciba.minExpiresIn;
					cibaMaxExpiresIn = data.settings.ciba.maxExpiresIn;
					cibaDefaultInterval = data.settings.ciba.defaultInterval;
					cibaMinInterval = data.settings.ciba.minInterval;
					cibaMaxInterval = data.settings.ciba.maxInterval;
					cibaSupportedDeliveryModes = data.settings.ciba.supportedDeliveryModes;
					cibaUserCodeEnabled = data.settings.ciba.userCodeEnabled;
					cibaBindingMessageMaxLength = data.settings.ciba.bindingMessageMaxLength;
					cibaNotificationsEnabled = data.settings.ciba.notificationsEnabled;
					cibaNotificationEmail = data.settings.ciba.notificationProviders?.email || false;
					cibaNotificationSms = data.settings.ciba.notificationProviders?.sms || false;
					cibaNotificationPush = data.settings.ciba.notificationProviders?.push || false;
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error loading settings:', err);
		} finally {
			loading = false;
		}
	}

	async function handleSave() {
		saving = true;
		error = '';
		successMessage = '';

		try {
			const { data, error: apiError } = await adminSettingsAPI.update({
				general: {
					siteName,
					logoUrl,
					language,
					timezone
				},
				appearance: {
					primaryColor,
					secondaryColor,
					fontFamily
				},
				security: {
					sessionTimeout,
					mfaEnforced,
					passwordMinLength,
					passwordRequireSpecialChar
				},
				email: {
					emailProvider,
					smtpHost,
					smtpPort,
					smtpUsername,
					smtpPassword
				},
				advanced: {
					accessTokenTtl,
					idTokenTtl,
					refreshTokenTtl,
					passkeyEnabled,
					magicLinkEnabled
				},
				ciba: {
					enabled: cibaEnabled,
					defaultExpiresIn: cibaDefaultExpiresIn,
					minExpiresIn: cibaMinExpiresIn,
					maxExpiresIn: cibaMaxExpiresIn,
					defaultInterval: cibaDefaultInterval,
					minInterval: cibaMinInterval,
					maxInterval: cibaMaxInterval,
					supportedDeliveryModes: cibaSupportedDeliveryModes,
					userCodeEnabled: cibaUserCodeEnabled,
					bindingMessageMaxLength: cibaBindingMessageMaxLength,
					notificationsEnabled: cibaNotificationsEnabled,
					notificationProviders: {
						email: cibaNotificationEmail,
						sms: cibaNotificationSms,
						push: cibaNotificationPush
					}
				}
			});

			if (apiError) {
				error = apiError.error_description || 'Failed to save settings';
				console.error('Failed to save settings:', apiError);
			} else if (data) {
				successMessage = 'Settings saved successfully';
				// Clear success message after 3 seconds
				setTimeout(() => {
					successMessage = '';
				}, 3000);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'An error occurred';
			console.error('Error saving settings:', err);
		} finally {
			saving = false;
		}
	}

	function setTab(tab: Tab) {
		activeTab = tab;
	}
</script>

<svelte:head>
	<title>{$LL.admin_settings_title()} - {$LL.app_title()}</title>
</svelte:head>

<div class="space-y-6">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-gray-900 dark:text-white">
				{$LL.admin_settings_title()}
			</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Configure your Authrim instance</p>
		</div>
		<Button variant="primary" onclick={handleSave} disabled={saving || loading}>
			{#if saving}
				<div class="i-heroicons-arrow-path h-4 w-4 animate-spin"></div>
			{/if}
			Save Changes
		</Button>
	</div>

	<!-- Error Message -->
	{#if error}
		<div class="rounded-lg bg-red-50 p-4 dark:bg-red-900/20">
			<div class="flex items-center gap-3">
				<div class="i-heroicons-exclamation-circle h-5 w-5 text-red-600 dark:text-red-400"></div>
				<p class="text-sm text-red-800 dark:text-red-200">{error}</p>
			</div>
		</div>
	{/if}

	<!-- Success Message -->
	{#if successMessage}
		<div class="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
			<div class="flex items-center gap-3">
				<div class="i-heroicons-check-circle h-5 w-5 text-green-600 dark:text-green-400"></div>
				<p class="text-sm text-green-800 dark:text-green-200">{successMessage}</p>
			</div>
		</div>
	{/if}

	<!-- Tabs -->
	<div class="border-b border-gray-200 dark:border-gray-700">
		<nav class="-mb-px flex space-x-8">
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'general'}
				class:text-primary-600={activeTab === 'general'}
				class:dark:text-primary-400={activeTab === 'general'}
				class:border-transparent={activeTab !== 'general'}
				class:text-gray-500={activeTab !== 'general'}
				class:hover:text-gray-700={activeTab !== 'general'}
				class:dark:text-gray-400={activeTab !== 'general'}
				class:dark:hover:text-gray-300={activeTab !== 'general'}
				onclick={() => setTab('general')}
			>
				{$LL.admin_settings_general()}
			</button>
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'appearance'}
				class:text-primary-600={activeTab === 'appearance'}
				class:dark:text-primary-400={activeTab === 'appearance'}
				class:border-transparent={activeTab !== 'appearance'}
				class:text-gray-500={activeTab !== 'appearance'}
				class:hover:text-gray-700={activeTab !== 'appearance'}
				class:dark:text-gray-400={activeTab !== 'appearance'}
				class:dark:hover:text-gray-300={activeTab !== 'appearance'}
				onclick={() => setTab('appearance')}
			>
				{$LL.admin_settings_appearance()}
			</button>
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'security'}
				class:text-primary-600={activeTab === 'security'}
				class:dark:text-primary-400={activeTab === 'security'}
				class:border-transparent={activeTab !== 'security'}
				class:text-gray-500={activeTab !== 'security'}
				class:hover:text-gray-700={activeTab !== 'security'}
				class:dark:text-gray-400={activeTab !== 'security'}
				class:dark:hover:text-gray-300={activeTab !== 'security'}
				onclick={() => setTab('security')}
			>
				{$LL.admin_settings_security()}
			</button>
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'email'}
				class:text-primary-600={activeTab === 'email'}
				class:dark:text-primary-400={activeTab === 'email'}
				class:border-transparent={activeTab !== 'email'}
				class:text-gray-500={activeTab !== 'email'}
				class:hover:text-gray-700={activeTab !== 'email'}
				class:dark:text-gray-400={activeTab !== 'email'}
				class:dark:hover:text-gray-300={activeTab !== 'email'}
				onclick={() => setTab('email')}
			>
				{$LL.admin_settings_email()}
			</button>
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'advanced'}
				class:text-primary-600={activeTab === 'advanced'}
				class:dark:text-primary-400={activeTab === 'advanced'}
				class:border-transparent={activeTab !== 'advanced'}
				class:text-gray-500={activeTab !== 'advanced'}
				class:hover:text-gray-700={activeTab !== 'advanced'}
				class:dark:text-gray-400={activeTab !== 'advanced'}
				class:dark:hover:text-gray-300={activeTab !== 'advanced'}
				onclick={() => setTab('advanced')}
			>
				{$LL.admin_settings_advanced()}
			</button>
			<button
				class="border-b-2 px-1 py-4 text-sm font-medium transition-colors"
				class:border-primary-500={activeTab === 'ciba'}
				class:text-primary-600={activeTab === 'ciba'}
				class:dark:text-primary-400={activeTab === 'ciba'}
				class:border-transparent={activeTab !== 'ciba'}
				class:text-gray-500={activeTab !== 'ciba'}
				class:hover:text-gray-700={activeTab !== 'ciba'}
				class:dark:text-gray-400={activeTab !== 'ciba'}
				class:dark:hover:text-gray-300={activeTab !== 'ciba'}
				onclick={() => setTab('ciba')}
			>
				CIBA
			</button>
		</nav>
	</div>

	<!-- Tab content -->
	{#if activeTab === 'general'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">General Settings</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label
						for="siteName"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Site Name
					</label>
					<Input id="siteName" type="text" bind:value={siteName} />
				</div>
				<div>
					<label
						for="logoUrl"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Logo URL
					</label>
					<Input
						id="logoUrl"
						type="url"
						bind:value={logoUrl}
						placeholder="https://example.com/logo.png"
					/>
				</div>
				<div>
					<label
						for="language"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Default Language
					</label>
					<select
						id="language"
						bind:value={language}
						class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
					>
						<option value="en">English</option>
						<option value="ja">日本語</option>
					</select>
				</div>
				<div>
					<label
						for="timezone"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Timezone
					</label>
					<select
						id="timezone"
						bind:value={timezone}
						class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
					>
						<option value="UTC">UTC</option>
						<option value="America/New_York">America/New_York</option>
						<option value="Europe/London">Europe/London</option>
						<option value="Asia/Tokyo">Asia/Tokyo</option>
					</select>
				</div>
			</div>
		</Card>
	{:else if activeTab === 'appearance'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Appearance Settings</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label
						for="primaryColor"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Primary Color
					</label>
					<div class="flex gap-2">
						<input
							id="primaryColor"
							type="color"
							bind:value={primaryColor}
							class="h-10 w-16 rounded border border-gray-300 dark:border-gray-600"
						/>
						<Input type="text" bind:value={primaryColor} placeholder="#3B82F6" />
					</div>
				</div>
				<div>
					<label
						for="secondaryColor"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Secondary Color
					</label>
					<div class="flex gap-2">
						<input
							id="secondaryColor"
							type="color"
							bind:value={secondaryColor}
							class="h-10 w-16 rounded border border-gray-300 dark:border-gray-600"
						/>
						<Input type="text" bind:value={secondaryColor} placeholder="#10B981" />
					</div>
				</div>
				<div>
					<label
						for="fontFamily"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Font Family
					</label>
					<select
						id="fontFamily"
						bind:value={fontFamily}
						class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
					>
						<option value="Inter">Inter</option>
						<option value="Roboto">Roboto</option>
						<option value="Open Sans">Open Sans</option>
						<option value="System">System Default</option>
					</select>
				</div>
			</div>
		</Card>
	{:else if activeTab === 'security'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Security Settings</h2>
			<div class="space-y-4">
				<div>
					<label
						for="sessionTimeout"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Session Timeout (seconds)
					</label>
					<Input id="sessionTimeout" type="number" bind:value={sessionTimeout} />
					<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
						Current: {Math.floor(sessionTimeout / 3600)} hours
					</p>
				</div>
				<div>
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							bind:checked={mfaEnforced}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm text-gray-700 dark:text-gray-300">Enforce MFA for all users</span>
					</label>
				</div>
				<div>
					<label
						for="passwordMinLength"
						class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
					>
						Password Minimum Length
					</label>
					<Input
						id="passwordMinLength"
						type="number"
						bind:value={passwordMinLength}
						min="6"
						max="128"
					/>
				</div>
				<div>
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							bind:checked={passwordRequireSpecialChar}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm text-gray-700 dark:text-gray-300"
							>Require special characters in password</span
						>
					</label>
				</div>
			</div>
		</Card>
	{:else if activeTab === 'email'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Email Settings</h2>
			<div class="space-y-4">
				<div>
					<div class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
						Email Provider
					</div>
					<div class="space-y-2">
						<label class="flex items-center gap-2">
							<input
								type="radio"
								bind:group={emailProvider}
								value="resend"
								class="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
							/>
							<span class="text-sm text-gray-700 dark:text-gray-300">Resend</span>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="radio"
								bind:group={emailProvider}
								value="cloudflare"
								class="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
							/>
							<span class="text-sm text-gray-700 dark:text-gray-300">Cloudflare Email Workers</span>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="radio"
								bind:group={emailProvider}
								value="smtp"
								class="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
							/>
							<span class="text-sm text-gray-700 dark:text-gray-300">SMTP</span>
						</label>
					</div>
				</div>

				{#if emailProvider === 'smtp'}
					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label
								for="smtpHost"
								class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								SMTP Host
							</label>
							<Input
								id="smtpHost"
								type="text"
								bind:value={smtpHost}
								placeholder="smtp.example.com"
							/>
						</div>
						<div>
							<label
								for="smtpPort"
								class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								SMTP Port
							</label>
							<Input id="smtpPort" type="number" bind:value={smtpPort} />
						</div>
						<div>
							<label
								for="smtpUsername"
								class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								SMTP Username
							</label>
							<Input id="smtpUsername" type="text" bind:value={smtpUsername} />
						</div>
						<div>
							<label
								for="smtpPassword"
								class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								SMTP Password
							</label>
							<Input id="smtpPassword" type="password" bind:value={smtpPassword} />
						</div>
					</div>
				{/if}

				<div>
					<Button variant="secondary">Send Test Email</Button>
				</div>
			</div>
		</Card>
	{:else if activeTab === 'advanced'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Advanced Settings</h2>
			<div class="space-y-4">
				<div class="grid gap-4 sm:grid-cols-3">
					<div>
						<label
							for="accessTokenTtl"
							class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
						>
							Access Token TTL (seconds)
						</label>
						<Input id="accessTokenTtl" type="number" bind:value={accessTokenTtl} />
						<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
							Current: {Math.floor(accessTokenTtl / 60)} minutes
						</p>
					</div>
					<div>
						<label
							for="idTokenTtl"
							class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
						>
							ID Token TTL (seconds)
						</label>
						<Input id="idTokenTtl" type="number" bind:value={idTokenTtl} />
						<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
							Current: {Math.floor(idTokenTtl / 60)} minutes
						</p>
					</div>
					<div>
						<label
							for="refreshTokenTtl"
							class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
						>
							Refresh Token TTL (seconds)
						</label>
						<Input id="refreshTokenTtl" type="number" bind:value={refreshTokenTtl} />
						<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
							Current: {Math.floor(refreshTokenTtl / 86400)} days
						</p>
					</div>
				</div>

				<div>
					<h3 class="mb-2 text-sm font-medium text-gray-900 dark:text-white">
						Authentication Methods
					</h3>
					<div class="space-y-2">
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								bind:checked={passkeyEnabled}
								class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
							/>
							<span class="text-sm text-gray-700 dark:text-gray-300"
								>Enable Passkey Authentication</span
							>
						</label>
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								bind:checked={magicLinkEnabled}
								class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
							/>
							<span class="text-sm text-gray-700 dark:text-gray-300"
								>Enable Magic Link Authentication</span
							>
						</label>
					</div>
				</div>
			</div>
		</Card>
	{:else if activeTab === 'ciba'}
		<Card>
			<h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
				CIBA (Client Initiated Backchannel Authentication) Settings
			</h2>
			<div class="space-y-6">
				<!-- Enable CIBA -->
				<div>
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							bind:checked={cibaEnabled}
							class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
						/>
						<span class="text-sm font-medium text-gray-700 dark:text-gray-300"
							>Enable CIBA Flow</span
						>
					</label>
					<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
						Allow clients to initiate backchannel authentication requests
					</p>
				</div>

				{#if cibaEnabled}
					<!-- Expiration Settings -->
					<div>
						<h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
							Expiration Settings
						</h3>
						<div class="grid gap-4 sm:grid-cols-3">
							<div>
								<label
									for="cibaDefaultExpiresIn"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Default Expires In (seconds)
								</label>
								<Input
									id="cibaDefaultExpiresIn"
									type="number"
									bind:value={cibaDefaultExpiresIn}
									min={cibaMinExpiresIn}
									max={cibaMaxExpiresIn}
								/>
								<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									{Math.floor(cibaDefaultExpiresIn / 60)} minutes
								</p>
							</div>
							<div>
								<label
									for="cibaMinExpiresIn"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Min Expires In (seconds)
								</label>
								<Input id="cibaMinExpiresIn" type="number" bind:value={cibaMinExpiresIn} min="30" />
								<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									{Math.floor(cibaMinExpiresIn / 60)} minutes
								</p>
							</div>
							<div>
								<label
									for="cibaMaxExpiresIn"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Max Expires In (seconds)
								</label>
								<Input
									id="cibaMaxExpiresIn"
									type="number"
									bind:value={cibaMaxExpiresIn}
									min={cibaMinExpiresIn}
								/>
								<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									{Math.floor(cibaMaxExpiresIn / 60)} minutes
								</p>
							</div>
						</div>
					</div>

					<!-- Polling Interval Settings -->
					<div>
						<h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
							Polling Interval Settings
						</h3>
						<div class="grid gap-4 sm:grid-cols-3">
							<div>
								<label
									for="cibaDefaultInterval"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Default Interval (seconds)
								</label>
								<Input
									id="cibaDefaultInterval"
									type="number"
									bind:value={cibaDefaultInterval}
									min={cibaMinInterval}
									max={cibaMaxInterval}
								/>
							</div>
							<div>
								<label
									for="cibaMinInterval"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Min Interval (seconds)
								</label>
								<Input id="cibaMinInterval" type="number" bind:value={cibaMinInterval} min="1" />
							</div>
							<div>
								<label
									for="cibaMaxInterval"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Max Interval (seconds)
								</label>
								<Input
									id="cibaMaxInterval"
									type="number"
									bind:value={cibaMaxInterval}
									min={cibaMinInterval}
								/>
							</div>
						</div>
					</div>

					<!-- Delivery Modes -->
					<div>
						<h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
							Supported Delivery Modes
						</h3>
						<div class="space-y-2">
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									checked={cibaSupportedDeliveryModes.includes('poll')}
									onchange={(e) => {
										if (e.currentTarget.checked) {
											cibaSupportedDeliveryModes = [...cibaSupportedDeliveryModes, 'poll'];
										} else {
											cibaSupportedDeliveryModes = cibaSupportedDeliveryModes.filter(
												(m) => m !== 'poll'
											);
										}
									}}
									class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								/>
								<span class="text-sm text-gray-700 dark:text-gray-300"
									>Poll Mode (Client polls for result)</span
								>
							</label>
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									checked={cibaSupportedDeliveryModes.includes('ping')}
									onchange={(e) => {
										if (e.currentTarget.checked) {
											cibaSupportedDeliveryModes = [...cibaSupportedDeliveryModes, 'ping'];
										} else {
											cibaSupportedDeliveryModes = cibaSupportedDeliveryModes.filter(
												(m) => m !== 'ping'
											);
										}
									}}
									class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								/>
								<span class="text-sm text-gray-700 dark:text-gray-300"
									>Ping Mode (Server notifies client)</span
								>
							</label>
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									checked={cibaSupportedDeliveryModes.includes('push')}
									onchange={(e) => {
										if (e.currentTarget.checked) {
											cibaSupportedDeliveryModes = [...cibaSupportedDeliveryModes, 'push'];
										} else {
											cibaSupportedDeliveryModes = cibaSupportedDeliveryModes.filter(
												(m) => m !== 'push'
											);
										}
									}}
									class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								/>
								<span class="text-sm text-gray-700 dark:text-gray-300"
									>Push Mode (Server pushes tokens directly)</span
								>
							</label>
						</div>
					</div>

					<!-- Additional Features -->
					<div>
						<h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
							Additional Features
						</h3>
						<div class="space-y-3">
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									bind:checked={cibaUserCodeEnabled}
									class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								/>
								<span class="text-sm text-gray-700 dark:text-gray-300"
									>Enable User Code Generation</span
								>
							</label>
							<div>
								<label
									for="cibaBindingMessageMaxLength"
									class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									Binding Message Max Length
								</label>
								<Input
									id="cibaBindingMessageMaxLength"
									type="number"
									bind:value={cibaBindingMessageMaxLength}
									min="0"
									max="500"
								/>
								<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									Maximum characters for binding messages (recommended: 140)
								</p>
							</div>
						</div>
					</div>

					<!-- Notifications -->
					<div>
						<h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
						<div class="space-y-3">
							<label class="flex items-center gap-2">
								<input
									type="checkbox"
									bind:checked={cibaNotificationsEnabled}
									class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
								/>
								<span class="text-sm font-medium text-gray-700 dark:text-gray-300"
									>Enable Notifications</span
								>
							</label>

							{#if cibaNotificationsEnabled}
								<div class="ml-6 space-y-2">
									<label class="flex items-center gap-2">
										<input
											type="checkbox"
											bind:checked={cibaNotificationEmail}
											class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
										/>
										<span class="text-sm text-gray-700 dark:text-gray-300">Email Notifications</span
										>
									</label>
									<label class="flex items-center gap-2">
										<input
											type="checkbox"
											bind:checked={cibaNotificationSms}
											class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
										/>
										<span class="text-sm text-gray-700 dark:text-gray-300">SMS Notifications</span>
									</label>
									<label class="flex items-center gap-2">
										<input
											type="checkbox"
											bind:checked={cibaNotificationPush}
											class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
										/>
										<span class="text-sm text-gray-700 dark:text-gray-300">Push Notifications</span>
									</label>
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</Card>
	{/if}
</div>
