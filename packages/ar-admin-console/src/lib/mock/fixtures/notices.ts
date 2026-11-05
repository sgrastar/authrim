import { adminAccess } from '#lib/access/admin-access.svelte.js';
import { createFakeAdminNotices } from '#lib/api/fake/admin-notices-fake.js';
import { createFakeNoticeDelivery } from '#lib/api/fake/notice-delivery-fake.js';
import { createNoticeInbox } from '#lib/shell/notices.svelte.js';

/**
 * The mock's notices: one in-memory API behind both the header and Operations → Notifications,
 * so what is resolved, dismissed or published on the page shows in the header too.
 */
export const mockNoticesClient = createFakeAdminNotices({
	delay: 120,
	// As the persona in the address sees them: platform notices only for a platform admin.
	platform: () => adminAccess.current.platform
});
export const mockNoticeInbox = createNoticeInbox(mockNoticesClient);

/** The mock's delivery side: the admin's email choices and the Slack channels of the tenant. */
export const mockNoticeDelivery = createFakeNoticeDelivery({
	delay: 120,
	platform: () => adminAccess.current.platform
});
