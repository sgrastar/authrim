<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
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

	function open(hasSecurityKey: boolean) {
		const prompt = new SecondFactorPromptState();
		const ask = () =>
			void prompt
				.ask({ hasSecurityKey, client: createFakeKeyringFactor({ answerAfterMs: 4_000 }) })
				.catch(() => undefined);
		ask();
		return { prompt, ask };
	}
</script>

<Story
	name="Choice"
	play={async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await body.findByText(t('kp.prompt.securityKeyHint'));
		await userEvent.click(body.getByRole('button', { name: t('kp.prompt.continue') }));
		await body.findByText(t('kp.code.label'));
		expect(body.getByRole('button', { name: t('kp.prompt.other') })).toBeTruthy();
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
