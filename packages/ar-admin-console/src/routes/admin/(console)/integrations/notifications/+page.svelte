<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { httpAdminNotices } from '#lib/api/admin-notices.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Notifications from '#lib/pages/integrations/Notifications.svelte';
	import { noticeInbox } from '#lib/shell/notice-inbox.js';

	const focusId = $derived(page.url.searchParams.get('id'));

	function follow(id: string | null) {
		const search = id ? `?id=${encodeURIComponent(id)}` : '';
		void goto(`${page.url.pathname}${search}`, { replaceState: true });
	}
</script>

<svelte:head>
	<title>{t('nt.page')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<Notifications
		client={httpAdminNotices}
		{focusId}
		onfocus={follow}
		onchanged={() => noticeInbox.refresh()}
	/>
{/key}
