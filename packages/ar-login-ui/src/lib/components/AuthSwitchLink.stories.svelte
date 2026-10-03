<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AuthSwitchLink from './AuthSwitchLink.svelte';

	const { Story } = defineMeta({
		title: 'Components/AuthSwitchLink',
		component: AuthSwitchLink,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The “Create account” / “Already have an account” link under the card. It does a full page load, so after a click it shows a spinner and ignores further clicks until the page changes. The tenant can hide it (`authSwitchLinkEnabled`).'
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story
	name="Click shows progress"
	play={async ({ canvasElement }) => {
		const link = within(canvasElement).getByRole('link');
		await userEvent.click(link);
		await expect(link).toHaveAttribute('aria-busy', 'true');
	}}
>
	{#snippet template()}
		<LoginUIFrame>
			<p class="auth-bottom-link">
				<AuthSwitchLink
					href="#signup"
					label={$LL.login_createAccount()}
					loadingLabel={$LL.common_loading()}
				/>
			</p>
		</LoginUIFrame>
	{/snippet}
</Story>
