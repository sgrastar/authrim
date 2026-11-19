<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { createFakeSamlSettings, mockSamlSettings } from '#lib/api/fake/saml-settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SamlLocal from './SamlLocal.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/SAML identity',
		component: SamlLocal,
		tags: ['autodocs'],
		parameters: {
			layout: 'padded',
			docs: {
				description: {
					component:
						'Authentication → SAML, the lower part of the page: the tenant’s own SAML identity. For each role (IdP, SP) what a partner registers — entity ID, metadata URL and its download — and the signing certificates as slots: in use, next, backup. A rollover is “Issue the next certificate” (a dialog for the subject, validity, key size and DNS names), then “Switch to the next certificate” once partners have it; the previous one stays as the backup until it is retired. Below: the published entity ID style and the interactive sign-in address (with the IDs the other style would give, before saving), the emergency key recreation, and the signing-key DR bundle (export with a passphrase typed twice; import of the JSON file, confirmed, replacing the keys). Operations that the Admin API protects with a step-up are run through `withStepUp`. Without the update permission the page is read-only; the DR bundle part needs its own two permissions, which the tenant admin and the super admin hold and the viewer does not.'
				}
			}
		}
	});

	const tenantAdmin = persona('tenant').access;
	const viewer = persona('viewer').access;
</script>

<Story
	name="Rollover in progress"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sl.role.idp.title'));
		// The IdP has a next certificate; the SP has only the one in use.
		await expect(await canvas.findAllByText(t('sl.slot.next'))).toHaveLength(1);
		await expect(canvas.getAllByRole('button', { name: t('sl.action.promoteNext') })).toHaveLength(
			1
		);
		// The DR bundle of the tenant's own signing keys is the tenant admin's to export and import.
		await canvas.findByText(t('sl.dr.title'));
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings({ delay: 150 })} access={tenantAdmin} />
	{/snippet}
</Story>

<Story
	name="Switch to the next certificate"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sl.action.promoteNext') }));
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.click(dialog.getByRole('button', { name: t('sl.action.promoteNext') }));
		// The previous certificate is now the backup, and nothing is next any more.
		await canvas.findByRole('button', { name: t('sl.action.retireBackup') });
		await expect(canvas.queryByRole('button', { name: t('sl.action.promoteNext') })).toBeNull();
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings()} access={tenantAdmin} />
	{/snippet}
</Story>

<Story
	name="Issue the next certificate"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const buttons = await canvas.findAllByRole('button', { name: t('sl.action.publishNext') });
		// The SP (second card) has no next certificate yet.
		await userEvent.click(buttons[1]);
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.clear(dialog.getByLabelText(t('sl.new.commonName')));
		await userEvent.type(dialog.getByLabelText(t('sl.new.commonName')), 'Acme SP 2027');
		await userEvent.click(dialog.getByRole('button', { name: t('sl.new.submit') }));
		await expect(await canvas.findAllByText(t('sl.slot.next'))).toHaveLength(2);
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings()} access={tenantAdmin} />
	{/snippet}
</Story>

<Story
	name="Entity ID style change previewed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('sl.pub.style.roleUrl')}`) })
		);
		await expect(await canvas.findAllByText(t('sl.pub.afterSave'))).toHaveLength(2);
		await canvas.findByText('https://acme.authrim.example/saml/idp');
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings()} access={tenantAdmin} />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sl.readOnly'));
		await expect(canvas.queryByRole('button', { name: t('sl.action.publishNext') })).toBeNull();
		await expect(canvas.queryByText(t('sl.dr.title'))).toBeNull();
		// Readers may not call the server's certificate preview: fingerprints are computed here.
		await expect(canvas.queryByText(t('sl.cert.previewFailed'))).toBeNull();
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings()} access={viewer} />
	{/snippet}
</Story>

<Story
	name="No signing keys stored yet"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findAllByText(t('sl.slot.defaultKey'))).toHaveLength(2);
	}}
>
	{#snippet template()}
		<SamlLocal
			client={createFakeSamlSettings({
				settings: {
					...mockSamlSettings(),
					localSigning: {
						...mockSamlSettings().localSigning!,
						idpSigningKeyPolicy: {},
						spSigningKeyPolicy: {}
					}
				}
			})}
			access={tenantAdmin}
		/>
	{/snippet}
</Story>

<Story
	name="DR bundle passphrase rules"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const first = await canvas.findByLabelText(t('sl.dr.passphrase'));
		const second = canvas.getByLabelText(t('sl.dr.passphrase.confirm'));
		await userEvent.type(first, 'short');
		await userEvent.type(second, 'short');
		await canvas.findByText(t('sl.dr.passphrase.short', { min: 12 }));
		await expect(canvas.getByRole('button', { name: t('sl.dr.export') })).toBeDisabled();
		await userEvent.clear(first);
		await userEvent.clear(second);
		await userEvent.type(first, 'correct horse battery');
		await userEvent.type(second, 'correct horse batter');
		await canvas.findByText(t('sl.dr.passphrase.mismatch'));
		await userEvent.type(second, 'y');
		await expect(canvas.getByRole('button', { name: t('sl.dr.export') })).toBeEnabled();
	}}
>
	{#snippet template()}
		<SamlLocal client={createFakeSamlSettings()} access={tenantAdmin} />
	{/snippet}
</Story>
