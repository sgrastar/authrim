<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import LanguageSwitch from '$lib/shell/LanguageSwitch.svelte';
	import Callout from '../patterns/Callout.svelte';
	import Button from '../primitives/Button.svelte';
	import TextField from '../primitives/TextField.svelte';
	import AuthLayout from './AuthLayout.svelte';

	const { Story } = defineMeta({
		title: 'Templates/Entry page',
		component: AuthLayout,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Pages outside the console — sign in, join by invitation, first-time setup: one centred card with the brand above and preferences below. `busy` (while a passkey prompt or a check runs) stops every control on the page, the language switch included; the button that started it shows `loading`.'
				}
			}
		}
	});
</script>

<Story name="Sign in">
	{#snippet template()}
		<AuthLayout title={t('login.title')} subtitle={t('login.subtitle')}>
			<Button variant="primary" icon="fingerprint" block>{t('login.passkey')}</Button>
		</AuthLayout>
	{/snippet}
</Story>

<Story name="Join">
	{#snippet template()}
		<AuthLayout title={t('join.title')} subtitle={t('join.subtitle')}>
			<TextField label={t('join.email')} type="email" />
			<TextField label={t('join.code')} />
			<Button variant="primary" block>{t('join.check')}</Button>
		</AuthLayout>
	{/snippet}
</Story>

<Story
	name="Signing in"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const running = canvas.getByRole('button', { name: t('login.authenticating') });
		await expect(running).toHaveAttribute('aria-busy', 'true');
		for (const language of canvas.getAllByRole('button', { pressed: false })) {
			await expect(language).toBeDisabled();
		}
	}}
>
	{#snippet template()}
		<AuthLayout title={t('login.title')} subtitle={t('login.subtitle')} busy>
			<Button variant="primary" icon="fingerprint" block loading>
				{t('login.authenticating')}
			</Button>
			<Callout>{t('login.hint')}</Callout>
			{#snippet footer()}<LanguageSwitch />{/snippet}
		</AuthLayout>
	{/snippet}
</Story>

<Story name="Join — checking">
	{#snippet template()}
		<AuthLayout title={t('join.title')} subtitle={t('join.subtitle')} busy>
			<TextField label={t('join.email')} type="email" value="admin@example.com" />
			<TextField label={t('join.code')} value="483920" />
			<Button variant="primary" block loading>{t('join.checking')}</Button>
			{#snippet footer()}<LanguageSwitch />{/snippet}
		</AuthLayout>
	{/snippet}
</Story>
