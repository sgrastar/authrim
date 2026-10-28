<script lang="ts">
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { createFakeTenantInfo } from '$lib/api/fake/tenant-info-fake';
	import TenantGeneral from '$lib/pages/tenant-general/TenantGeneral.svelte';

	const client = createFakeSettings();
	const info = createFakeTenantInfo({ delay: 120 });
</script>

<TenantGeneral {client} {info} tenantId="acme" />
