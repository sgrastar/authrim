<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Button from './Button.svelte';

	const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;

	const { Story } = defineMeta({
		title: 'Components/Button',
		component: Button,
		tags: ['autodocs'],
		args: { onclick: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'The standard action button of the legacy (non-runtime) layout and of every page outside login and signup. `primary` is the single main action of a card; `secondary` is for alternatives; `ghost` for low-emphasis actions such as Back; `danger` for destructive ones. Runtime screens render `button.runtime-auth-button` instead (see **Catalog / Buttons**).'
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="Variants">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:flex;gap:12px;flex-wrap:wrap">
				<Button>{$LL.common_continue()}</Button>
				<Button variant="secondary">{$LL.login_sendCode()}</Button>
				<Button variant="ghost">{$LL.common_backToLogin()}</Button>
				<Button variant="danger">{$LL.consent_denyButton()}</Button>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Sizes">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
				<Button size="sm">{$LL.common_continue()}</Button>
				<Button size="md">{$LL.common_continue()}</Button>
				<Button size="lg">{$LL.common_continue()}</Button>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="States">
	{#snippet template()}
		<LoginUIFrame>
			<div
				style="display:grid;grid-template-columns:repeat(4,max-content);gap:12px;align-items:center"
			>
				{#each variants as variant (variant)}
					<Button {variant}>{variant}</Button>
				{/each}
				{#each variants as variant (variant)}
					<Button {variant} disabled>{variant}</Button>
				{/each}
				{#each variants as variant (variant)}
					<Button {variant} loading>{variant}</Button>
				{/each}
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="With icon">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:flex;flex-direction:column;gap:12px;max-width:360px">
				<Button class="w-full"><i class="i-ph-key"></i>{$LL.login_signInWithPasskey()}</Button>
				<Button variant="secondary" class="w-full">
					<i class="i-ph-envelope-simple"></i>{$LL.login_sendCode()}
				</Button>
				<Button variant="ghost" size="sm"
					><i class="i-ph-arrow-left"></i>{$LL.common_backToLogin()}</Button
				>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Interaction"
	play={async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole('button');
		await userEvent.click(button);
		await expect(args.onclick).toHaveBeenCalledOnce();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame>
			<Button onclick={args.onclick as (event: MouseEvent) => void}>{$LL.common_continue()}</Button>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="As a link"
	play={async ({ canvasElement }) => {
		// Navigation is one link drawn as a button, never a button inside a link.
		const link = within(canvasElement).getByRole('link');
		await expect(link.getAttribute('href')).toBe('/discover');
		await expect(canvasElement.querySelector('a button, button a')).toBeNull();
	}}
>
	{#snippet template()}
		<LoginUIFrame>
			<Button href="/discover" reload>{$LL.header_login()}</Button>
		</LoginUIFrame>
	{/snippet}
</Story>
