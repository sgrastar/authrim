import { httpAdminNotices } from '#lib/api/admin-notices.js';
import { createNoticeInbox } from './notices.svelte.js';

/** The console's one inbox: the header reads it and the Notifications page refreshes it. */
export const noticeInbox = createNoticeInbox(httpAdminNotices);
