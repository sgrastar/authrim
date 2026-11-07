/**
 * Not translated yet: these strings are English placeholders (the same text as `./en.ts`).
 * Replace them with a real translation before this page is offered in this language.
 */
import type { jaTeam } from './ja';

export const deTeam: Record<keyof typeof jaTeam, string> = {
	'tm.page.desc':
		'The administrators of this tenant and the invitations sent. Administrators are added by invitation: the person invited becomes one once they register a passkey.',
	'tm.tab.admins': 'Administrators',
	'tm.tab.invitations': 'Invitations',
	'tm.tab.signin': 'Sign-in settings',
	'tm.invite': 'Invite administrator',

	'tm.admins.title': 'Administrators',
	'tm.admins.search': 'Search by email address',
	'tm.admins.filter.status': 'Status',
	'tm.admins.filter.mfa': 'Two-step verification',
	'tm.admins.filter.all': 'All',
	'tm.admins.filter.mfaOn': 'Set up',
	'tm.admins.filter.mfaOff': 'Not set up',
	'tm.admins.col.admin': 'Administrator',
	'tm.admins.col.status': 'Status',
	'tm.admins.col.mfa': 'Two-step verification',
	'tm.admins.col.lastLogin': 'Last sign-in',
	'tm.admins.col.actions': 'Actions for {name}',
	'tm.admins.never': 'Not yet',
	'tm.admins.empty': 'No administrators match',
	'tm.admins.emptyBody': 'Change the search or the filters.',
	'tm.admins.noAccess': 'You do not have access to the administrators.',
	'tm.admins.loadFailed': 'Could not load the administrators.',
	'tm.admins.homeNote':
		'Administrators who belong to this tenant. An administrator with a role for every tenant is listed only in the tenant they belong to.',

	'tm.status.active': 'Active',
	'tm.status.suspended': 'Suspended',
	'tm.status.locked': 'Locked',
	'tm.mfa.on': 'Set up',
	'tm.mfa.off': 'Not set up',

	'tm.action.suspend': 'Suspend',
	'tm.action.activate': 'Reactivate',
	'tm.action.unlock': 'Unlock',
	'tm.suspend.title': 'Suspend {name}?',
	'tm.suspend.body':
		'A suspended administrator cannot sign in to the console, and their current sessions end. "Reactivate" undoes it.',
	'tm.activate.title': 'Reactivate {name}?',
	'tm.activate.body': 'This administrator will be able to sign in to the console again.',
	'tm.unlock.title': 'Unlock {name}?',
	'tm.unlock.body':
		'Removes the lock that repeated failed sign-ins put on the account, and resets the count of failures.',
	'tm.toast.suspended': '{name} is suspended',
	'tm.toast.activated': '{name} is reactivated',
	'tm.toast.unlocked': '{name} is unlocked',

	'tm.inv.title': 'Invitations',
	'tm.inv.showCompleted': 'Also show accepted, revoked and expired',
	'tm.inv.limitNote': 'The latest 100 are shown.',
	'tm.inv.col.invitee': 'Invited',
	'tm.inv.col.role': 'Role',
	'tm.inv.col.status': 'Status',
	'tm.inv.col.delivery': 'Email',
	'tm.inv.col.expires': 'Can be accepted until',
	'tm.inv.col.actions': 'Actions for the invitation to {name}',
	'tm.inv.empty': 'No invitations are waiting',
	'tm.inv.emptyBody': 'Use "Invite administrator" to invite a new one.',
	'tm.inv.emptyAll': 'No invitations yet',
	'tm.inv.noAccess': 'You do not have access to the invitations.',
	'tm.inv.loadFailed': 'Could not load the invitations.',
	'tm.inv.status.pending': 'Waiting',
	'tm.inv.status.expired': 'Expired',
	'tm.inv.status.accepted': 'Accepted',
	'tm.inv.status.revoked': 'Revoked',
	'tm.inv.delivery.pending': 'Sending',
	'tm.inv.delivery.sent': 'Sent',
	'tm.inv.delivery.failed': 'Not sent',
	'tm.inv.scope.global': 'Every tenant',
	'tm.inv.action.resend': 'Send the invitation again',
	'tm.inv.action.revoke': 'Revoke the invitation',
	'tm.resend.title': 'Send the invitation to {email} again?',
	'tm.resend.body':
		'A new code is sent. The code sent before stops working, and the time to accept starts again from now.',
	'tm.revoke.title': 'Revoke the invitation to {email}?',
	'tm.revoke.body': 'The code sent stops working. To invite them again, send a new invitation.',
	'tm.toast.resent': 'The invitation to {email} was sent again',
	'tm.toast.resentNotDelivered':
		'The invitation to {email} was renewed, but the email could not be sent. Check the email settings and send it again.',
	'tm.toast.revoked': 'The invitation to {email} is revoked',

	'tm.new.title': 'Invite administrator',
	'tm.new.desc':
		'Sends an invitation by email. The person enters the code and registers a passkey, and becomes an administrator with the role chosen here.',
	'tm.new.back': 'Back to administrators',
	'tm.new.who': 'Who to invite',
	'tm.new.email': 'Email address',
	'tm.new.name': 'Name',
	'tm.new.nameHint': 'Left empty, the person enters it when they register.',
	'tm.new.access': 'What they get',
	'tm.new.role': 'Role',
	'tm.new.roleHint':
		'A role above your own can be chosen but is refused when sent. Super administrators (ar_super_admin) are invited for every tenant only.',
	'tm.new.scope': 'Where the role applies',
	'tm.new.scope.tenant': 'This tenant',
	'tm.new.scope.tenantBody': 'They hold the role only in the tenant selected now.',
	'tm.new.scope.global': 'Every tenant',
	'tm.new.scope.globalBody':
		'They hold the role in every tenant. Only administrators who belong to the deployment’s default tenant can be given it.',
	'tm.new.globalElsewhere':
		'A role for every tenant can be given only while the deployment’s default tenant is selected. Here, the invitation is for this tenant.',
	'tm.new.roleEnds': 'Role ends',
	'tm.new.roleEndsHint': 'Left empty, the role does not end.',
	'tm.new.groups': 'Groups to join',
	'tm.new.groupsHint':
		'On accepting, they join the groups chosen (up to 10) and hold the groups’ roles too.',
	'tm.new.groupsNone': 'This tenant has no administrator groups yet.',
	'tm.new.groupsChanged':
		'If a group’s members or roles change between sending the invitation and its acceptance, they do not join that group. Add them to it afterwards.',
	'tm.new.groupMeta': '{members} members · {grants} roles',
	'tm.new.groupsTooMany': 'Up to 10 groups can be chosen.',
	'tm.new.limits': 'How it can be accepted',
	'tm.new.expiresIn': 'Time to accept',
	'tm.new.expires.24': '24 hours',
	'tm.new.expires.72': '3 days',
	'tm.new.expires.168': '7 days',
	'tm.new.ip': 'Restrict by IP address',
	'tm.new.ipBody':
		'Accepting the invitation, and signing in afterwards, works only from the addresses given.',
	'tm.new.ipRanges': 'Allowed addresses',
	'tm.new.ipRangesHint': 'An IP address or a CIDR range (203.0.113.0/24).',
	'tm.new.ipRequired': 'Enter at least one allowed address.',
	'tm.new.emailRequired': 'Enter an email address.',
	'tm.new.emailInvalid': 'This is not an email address.',
	'tm.new.roleRequired': 'Choose a role.',
	'tm.new.roleEndsPast': 'The role’s end must be in the future.',
	'tm.new.roleEndsInvalid': 'The role’s end is not a date and time. Enter it again.',
	'tm.new.submit': 'Send invitation',
	'tm.new.sending': 'Sending…',
	'tm.new.loadFailed': 'Could not load the roles and groups.',
	'tm.new.noAccess': 'You do not have permission to invite administrators.',
	'tm.toast.invited': 'An invitation was sent to {email}',
	'tm.toast.invitedNotDelivered':
		'The invitation to {email} was created, but the email could not be sent. Send it again from the Invitations tab.',

	'tm.error.generic': 'That did not work. Try again.',
	'tm.error.forbidden':
		'You do not have permission for this. Administrators holding a role equal to or above yours may be out of your reach.',
	'tm.error.lastTenantAdmin':
		'The last administrator of this tenant cannot be suspended or lose their role. Add another administrator first.',
	'tm.error.lastPlatformAdmin':
		'The last administrator for every tenant cannot be suspended or lose their role. Add another one first.',
	'tm.error.invitationExists': 'This address already has an invitation waiting.',
	'tm.error.adminExists': 'An administrator already uses this address.',
	'tm.error.invalidScope':
		'This role cannot be given with this scope. A role for every tenant needs the authority of an administrator for every tenant.',
	'tm.error.crossTenant':
		'A role for every tenant can only be given to administrators who belong to the deployment’s default tenant. Select the default tenant, then invite.',
	'tm.error.roleNotFound': 'The role chosen no longer exists. Reload and choose again.',
	'tm.error.groupNotFound': 'A group chosen no longer exists. Reload and choose again.',
	'tm.error.invalidIpRanges': 'An allowed address is not valid.',
	'tm.error.invalidRequest': 'A value entered is not valid.',
	'tm.error.resendConflict': 'This ran into another change. Reload the list and try again.',
	'tm.error.changed': 'Someone changed this meanwhile. Reload, check it, then try again.',
	'tm.error.notFound': 'Not found. It may have changed meanwhile: reload the list.',
	'tm.error.cancelled': 'The identity check was cancelled, so nothing was sent.'
};
