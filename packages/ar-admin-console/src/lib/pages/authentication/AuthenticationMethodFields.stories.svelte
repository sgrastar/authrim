<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import AuthenticationMethodFields from './AuthenticationMethodFields.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Sign-in method fields',
		component: AuthenticationMethodFields,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The reusable method settings used by the profile page. The narrow example shows the same fields inside a service-flow side panel.'
				}
			}
		}
	});
	const values = {
		'authentication-methods.passkey.signup_enabled': true,
		'authentication-methods.passkey.login_enabled': true,
		'authentication-methods.email_otp.login_enabled': true,
		'authentication-methods.totp.reauth_enabled': true,
		'authentication-methods.passkey.guest_upgrade_enabled': true
	};
</script>

<Story name="Full page">
	{#snippet template()}
		<div style="padding: 24px">
			<AuthenticationMethodFields {values} canWrite onchange={() => {}} />
		</div>
	{/snippet}
</Story>

<Story name="Service-flow side panel">
	{#snippet template()}
		<div style="width: min(360px, 100%); padding: 16px">
			<AuthenticationMethodFields {values} canWrite onchange={() => {}} />
		</div>
	{/snippet}
</Story>
