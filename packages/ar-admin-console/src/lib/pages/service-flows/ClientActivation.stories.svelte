<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { ClientDetail } from '#lib/api/clients.js';
	import ClientActivation from './ClientActivation.svelte';
	const { Story } = defineMeta({
		title: 'Pages/Service flows/Client activation',
		component: ClientActivation
	});
	const draft: ClientDetail = {
		id: 'portal',
		name: 'Portal',
		redirectUris: ['https://app.example/cb'],
		enabled: false,
		enableBlockers: [],
		applicationType: 'web',
		authMethod: 'client_secret_basic',
		pkce: true,
		updatedAt: 1000
	};
	const cancel = fn(async () => {
		throw new StepUpCancelledError();
	});
	const disable = fn(async () => ({ ...draft, enabled: false, updatedAt: 1001 }));
	const onupdated = fn();
	const onreload = fn();
</script>

<Story
	name="Activation cancelled"
	args={{ client: draft, canEdit: true, update: cancel, onupdated, onreload }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.live.enable') }));
		await expect(canvas.getByText(t('settings.stepUpCancelled'))).toBeVisible();
	}}
/>
<Story
	name="Missing settings block activation"
	args={{
		client: { ...draft, redirectUris: [], enableBlockers: ['redirect_uris', 'jwks'] },
		canEdit: true,
		update: cancel,
		onupdated,
		onreload
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: t('sf.live.enable') })).toBeDisabled();
		await expect(canvas.getByText(t('sf.rp.missing.redirect_uris'))).toBeVisible();
		await expect(canvas.getByText(t('sf.rp.missing.jwks'))).toBeVisible();
	}}
/>
<Story
	name="Disable with L1"
	args={{
		client: { ...draft, enabled: true },
		canEdit: true,
		update: disable,
		onupdated,
		onreload
	}}
	play={async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole('button', { name: t('sf.live.disable') })
		);
		await expect(disable).toHaveBeenCalledWith(false, 1000);
	}}
/>
