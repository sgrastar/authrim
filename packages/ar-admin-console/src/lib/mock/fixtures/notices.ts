import { adminAccess } from '#lib/access/admin-access.svelte.js';
import { createFakeAdminNotices } from '#lib/api/fake/admin-notices-fake.js';
import { createFakeNoticeDelivery } from '#lib/api/fake/notice-delivery-fake.js';
import { createFakeStepUp } from '#lib/api/fake/step-up-fake.js';
import { createNoticeInbox } from '#lib/shell/notices.svelte.js';

function noticesParam(): string | null {
	return typeof window === 'undefined'
		? null
		: new URLSearchParams(window.location.search).get('notices');
}

/**
 * The mock's step-up: the console's own dialog asks, the checks are assumed to succeed after a
 * moment and stay fresh for five minutes, as on a real session.
 */
export const mockStepUp = createFakeStepUp({ delay: 600 });

/**
 * The mock's notices: one in-memory API behind both the header and Operations → Notifications,
 * so what is resolved, dismissed or published on the page shows in the header too.
 */
export const mockNoticesClient = createFakeAdminNotices({
	delay: 120,
	// /mock?notices=none: the header with nothing to tell (read when the mock loads).
	...(noticesParam() === 'none' ? { notices: [] } : {}),
	// As the persona in the address sees them: platform notices only for a platform admin.
	platform: () => adminAccess.current.platform
});
export const mockNoticeInbox = createNoticeInbox(mockNoticesClient);

/** The mock's delivery side: the admin's email choices and the Slack channels of the tenant. */
export const mockNoticeDelivery = createFakeNoticeDelivery({
	delay: 120,
	// Changing a channel's webhook URL asks for a step-up (L2) through the console's dialog.
	stepUp: mockStepUp,
	platform: () => adminAccess.current.platform
});
