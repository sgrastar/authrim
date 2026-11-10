<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { BUILT_IN_METHODS } from './authentication-method-fields';
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
		'authentication-methods.did.login_enabled': true,
		'authentication-methods.directory_password.enabled': false,
		'authentication-methods.passkey.guest_upgrade_enabled': true
	};
</script>

<Story
	name="Full page"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const cell = canvas.getAllByRole('checkbox')[0].closest('.method-grid__cell');
		const box = cell?.querySelector('.checkbox__box');
		await expect(cell).not.toBeNull();
		await expect(box).not.toBeNull();
		const cellRect = cell!.getBoundingClientRect();
		const boxRect = box!.getBoundingClientRect();
		await expect(
			Math.abs(cellRect.x + cellRect.width / 2 - boxRect.x - boxRect.width / 2)
		).toBeLessThan(1);
		await expect(
			Math.abs(cellRect.y + cellRect.height / 2 - boxRect.y - boxRect.height / 2)
		).toBeLessThan(1);
		const didRow = canvas
			.getByText(t('am.methods.did'), { selector: 'strong' })
			.closest('.method-grid__row');
		await expect(didRow?.querySelectorAll('.na')).toHaveLength(3);
		await expect(
			canvas.getByRole('checkbox', {
				name: `${t('am.methods.did')} / ${t('am.methods.login')}`
			})
		).toBeChecked();
		await expect(
			canvas.getByRole('checkbox', {
				name: `${t('am.methods.directoryPassword')} / ${t('am.methods.login')}`
			})
		).toBeDisabled();
		await expect(canvas.getByText(t('am.methods.notConfigured'))).toBeInTheDocument();
		await expect(
			canvas.getByRole('link', { name: t('am.methods.directorySettings') })
		).toHaveAttribute('href', '/admin/authentication/directory');
		for (const method of BUILT_IN_METHODS) {
			const help = canvas.getByRole('button', {
				name: t('am.methods.about', { name: t(method.label) })
			});
			await userEvent.hover(help);
			await expect(canvas.getByRole('tooltip')).toHaveTextContent(t(method.description));
			await userEvent.unhover(help);
		}
	}}
>
	{#snippet template()}
		<div style="padding: 24px">
			<AuthenticationMethodFields
				{values}
				canWrite
				directoryStatus="unconfigured"
				onchange={() => {}}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Service-flow side panel">
	{#snippet template()}
		<div style="width: min(360px, 100%); padding: 16px">
			<AuthenticationMethodFields {values} canWrite directoryStatus="ready" onchange={() => {}} />
		</div>
	{/snippet}
</Story>
