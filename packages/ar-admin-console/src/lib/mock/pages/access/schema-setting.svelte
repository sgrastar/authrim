<script lang="ts">
	import { createFakeSchemaSetting } from '$lib/api/fake/schema-setting-fake';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import SchemaSetting from '$lib/pages/schema-setting/SchemaSetting.svelte';

	const client = createFakeSchemaSetting({ delay: 120 });
	const settings = createFakeSettings();
</script>

<SchemaSetting {client} {settings} tenantId="acme" />
