<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { ApiError } from '#lib/api/api-error.js';
	import { createFakeKeyringFactor } from '#lib/api/fake/keyring-factor-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SecondFactorPrompt from './SecondFactorPrompt.svelte';
	import { SecondFactorPromptState } from './second-factor-prompt.svelte.js';

	const { Story } = defineMeta({
		title: 'Patterns/Second factor prompt',
		component: SecondFactorPrompt,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The second-factor question of an L2 step-up, for admins who registered Keyring: Authrim Keyring (QR code and a two-digit number) or a security key. With Keyring as the only second factor the dialog goes straight to the QR code. Mounted once in the root layout and opened by withStepUp; closing it cancels the operation like a cancelled security-key prompt.'
				}
			}
		}
	});

	function open(
		hasSecurityKey: boolean,
		extra: {
			hasKeyring?: boolean;
			hasTotp?: boolean;
			verifyTotp?: (code: string) => Promise<void>;
		} = {}
	) {
		const prompt = new SecondFactorPromptState();
		const ask = () =>
			void prompt
				.ask({
					hasSecurityKey,
					client: createFakeKeyringFactor({ answerAfterMs: 4_000 }),
					...extra
				})
				.catch(() => undefined);
		ask();
		return { prompt, ask };
	}

	/** Accepts 123456 only, like the server accepts the current code once. */
	async function fakeVerify(code: string) {
		if (code !== '123456') throw new ApiError(400, 'verification_failed', 'Code was not verified');
	}
</script>

<Story
	name="Choice"
	play={async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await body.findByText(t('kp.prompt.securityKeyHint'));
		await userEvent.click(body.getByRole('button', { name: t('kp.prompt.continue') }));
		await body.findByText(t('kp.code.label'));
		expect(body.getByRole('button', { name: t('kp.prompt.back') })).toBeTruthy();
	}}
>
	{#snippet template()}
		{@const demo = open(true)}
		<Button onclick={demo.ask}>{t('kp.prompt.title')}</Button>
		<SecondFactorPrompt prompt={demo.prompt} />
	{/snippet}
</Story>

<Story name="Keyring only">
	{#snippet template()}
		{@const demo = open(false)}
		<Button onclick={demo.ask}>{t('kp.prompt.title')}</Button>
		<SecondFactorPrompt prompt={demo.prompt} />
	{/snippet}
</Story>

<Story
	name="Authenticator app only"
	play={async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		// With no other way to confirm, the dialog asks for the code right away.
		const field = await body.findByLabelText(t('kp.totp.label'));
		await userEvent.type(field, '000000');
		await userEvent.click(body.getByRole('button', { name: t('kp.totp.verify') }));
		await body.findByText(t('kp.totp.error.invalid'));
	}}
>
	{#snippet template()}
		{@const demo = open(false, { hasKeyring: false, hasTotp: true, verifyTotp: fakeVerify })}
		<Button onclick={demo.ask}>{t('kp.prompt.title')}</Button>
		<SecondFactorPrompt prompt={demo.prompt} />
	{/snippet}
</Story>

<Story
	name="Security key or authenticator app"
	play={async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await body.findByText(t('kp.prompt.totpHint')));
		await userEvent.click(body.getByRole('button', { name: t('kp.prompt.continue') }));
		await body.findByLabelText(t('kp.totp.label'));
		expect(body.getByRole('button', { name: t('kp.prompt.back') })).toBeTruthy();
	}}
>
	{#snippet template()}
		{@const demo = open(true, { hasKeyring: false, hasTotp: true, verifyTotp: fakeVerify })}
		<Button onclick={demo.ask}>{t('kp.prompt.title')}</Button>
		<SecondFactorPrompt prompt={demo.prompt} />
	{/snippet}
</Story>
