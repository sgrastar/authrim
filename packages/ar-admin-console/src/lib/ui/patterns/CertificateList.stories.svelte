<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import CertificateList, { type CertificateItem } from './CertificateList.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Certificate list',
		component: CertificateList,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A partner’s certificates, one under another: which is in use and which is next, and when each expires. The expiry turns to a warning within `warnDays` (30 by default) and to danger once it has passed. A rollover is two entries; the next one can be made the one in use.'
				}
			}
		}
	});

	const ROLLOVER: CertificateItem[] = [
		{
			fingerprint: 'SHA-256 7C:1A:9E:44:B2:0D:F3:58 …',
			subject: 'CN=idp.example',
			notAfter: '2026-12-12',
			daysLeft: 29,
			use: 'active'
		},
		{
			fingerprint: 'SHA-256 A4:61:0F:9B:3E:C2:57:D0 …',
			subject: 'CN=idp.example',
			notAfter: '2028-01-31',
			daysLeft: 444,
			use: 'next'
		}
	];
</script>

<Story
	name="Rollover"
	args={{ label: 'Certificates', items: ROLLOVER, onpromote: fn(), onremove: fn() }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Make it the one in use' }));
		await expect(args.onpromote).toHaveBeenCalledWith(1);
	}}
/>

<Story
	name="Expired"
	args={{
		label: 'Certificates',
		items: [{ ...ROLLOVER[0], daysLeft: -3, notAfter: '2026-11-10' }]
	}}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText('Expired')).toBeInTheDocument();
	}}
/>

<Story name="Read only" args={{ label: 'Certificates', items: [ROLLOVER[1]] }} />

<Story name="Empty" args={{ label: 'Certificates', items: [] }} />
