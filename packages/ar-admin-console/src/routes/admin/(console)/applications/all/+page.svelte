<script lang="ts">
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAuthenticationMethodProfiles } from '#lib/api/authentication-method-profiles.js';
	import { httpSessionProfiles } from '#lib/api/session-profiles.js';
	import { readAppliedThemeValues } from '#lib/api/login-ui-themes.js';
	import { httpScreens } from '#lib/api/screens.js';
	import { httpClients } from '#lib/api/clients.js';
	import { httpFlows } from '#lib/api/flows.js';
	import { httpSamlProviders } from '#lib/api/saml-providers.js';
	import { httpSettings } from '#lib/api/settings.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccountServiceFlowsPage from '#lib/pages/service-flows/AccountServiceFlowsPage.svelte';
	import { provideFlowResources } from '#lib/pages/service-flows/flow-resources-context.js';

	// The flows choose from the tenant's screens and sign-in method profiles, and can add profiles.
	provideFlowResources({
		methodProfiles: httpAuthenticationMethodProfiles,
		sessionProfiles: httpSessionProfiles,
		screens: httpScreens,
		clients: httpClients,
		flows: httpFlows,
		samlProviders: httpSamlProviders,
		canCreateProfile: () => hasPermission(adminAccess.current, 'admin:settings:write'),
		loadTheme: (signal) => readAppliedThemeValues(tenantScope.tenantId, signal),
		failedSignInLimit: async (signal) => {
			const tenantId = tenantScope.tenantId;
			if (!tenantId) throw new Error('tenant_unknown');
			const { values } = await httpSettings.get(
				{ level: 'tenant', tenantId },
				'rate-limit',
				signal
			);
			const limit = values['rate_limit.auth_max_failed_attempts'];
			if (typeof limit !== 'number') throw new Error('rate_limit_unreadable');
			return limit;
		}
	});
</script>

<svelte:head>
	<title>{t('nav.apps.all')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<AccountServiceFlowsPage />
{/key}
