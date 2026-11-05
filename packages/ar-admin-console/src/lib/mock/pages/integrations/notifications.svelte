<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Notifications from '#lib/pages/integrations/Notifications.svelte';
	import { mockNoticeDelivery, mockNoticeInbox, mockNoticesClient } from '../../fixtures/notices';

	// As on the real page: the address says which notice is open (the header links with `?id=`).
	const focusId = $derived(page.url.searchParams.get('id'));

	function follow(id: string | null) {
		const url = new URL(page.url.href);
		if (id) url.searchParams.set('id', id);
		else url.searchParams.delete('id');
		void goto(`${url.pathname}${url.search}`, { replaceState: true });
	}
</script>

<Notifications
	client={mockNoticesClient}
	delivery={mockNoticeDelivery}
	{focusId}
	onfocus={follow}
	onchanged={() => mockNoticeInbox.refresh()}
/>
