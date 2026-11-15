import type { jaMachineAccess } from './ja';

export const enMachineAccess: Record<keyof typeof jaMachineAccess, string> = {
	'mc.page.desc':
		'Register automations and systems, rather than people, to use the Authrim Admin API. A machine signs in by signing with its own private key (private_key_jwt); Authrim keeps only the public key.',
	'mc.create': 'New',
	'mc.advanced': 'Advanced settings',

	'mc.list.title': 'Machines',
	'mc.list.noAccess': 'You do not have access to machine access',
	'mc.list.loadFailed': 'The machines could not be loaded',
	'mc.list.empty': 'No machines yet',
	'mc.list.emptyBody':
		'Machine access lets something that is not a person, such as a CI job or an automation, use the Admin API. Choose "New" to register one, then add its public key so it can sign in.',
	'mc.list.open': 'Open {name}',
	'mc.list.col.name': 'Name / client ID',
	'mc.list.col.type': 'Type',
	'mc.list.col.status': 'Status',
	'mc.list.col.keys': 'Working keys',
	'mc.list.col.updated': 'Updated',

	'mc.status.active': 'Active',
	'mc.status.disabled': 'Disabled',
	'mc.status.deleted': 'Deleted',

	'mc.type.automation': 'Automation',
	'mc.type.ci': 'CI / deployment',
	'mc.type.integration': 'External service integration',
	'mc.type.mcp_server': 'MCP server',
	'mc.type.ai_agent': 'AI agent',
	'mc.type.internal_service': 'Internal service (platform)',
	'mc.type.setup_tool': 'Setup tool (platform)',
	'mc.type.admin_ui_bff': 'Admin console relay (platform)',

	'mc.reach.none': 'No tenants',
	'mc.reach.noneDesc': 'Even with permissions, it cannot be used in any tenant.',
	'mc.reach.tenants': 'Chosen tenants only',
	'mc.reach.tenantsDesc': 'It works only in the tenants you choose below.',
	'mc.reach.all': 'All tenants',
	'mc.reach.allDesc': 'It works across the whole platform. Choose this only when needed.',

	'mc.f.name': 'Display name',
	'mc.f.clientId': 'Client ID',
	'mc.f.clientIdHint':
		'The ID the machine names itself with when it signs in. No spaces, and it cannot be changed later.',
	'mc.f.permissions': 'Permissions',
	'mc.f.permissionsHint':
		'One permission per line (for example admin:users:read). You can hand out only permissions you hold yourself.',
	'mc.f.permissionAdd': 'Add permission',
	'mc.f.reach': 'Tenants it reaches',
	'mc.f.reachTenants': 'Tenants',
	'mc.f.description': 'Description',
	'mc.f.type': 'Type',
	'mc.f.typeHint':
		'What it is used for. Only a platform administrator can create the platform types.',
	'mc.f.ttl': 'Token lifetime',
	'mc.f.ttlUnit': 'seconds',
	'mc.f.ttlHint': 'How long an access token it receives stays valid. At most {max} seconds.',

	'mc.perm.space': 'A permission cannot contain spaces',
	'mc.perm.long': 'This permission is too long',

	'mc.new.title': 'Register a machine',
	'mc.new.desc':
		'This hands out permissions and tenant access, so saving may ask for an additional identity check (step-up).',
	'mc.new.submit': 'Register',
	'mc.new.advancedDesc':
		'Description, type and token lifetime. You usually do not need to change these.',
	'mc.new.nameRequired': 'Enter a display name',
	'mc.new.clientIdInvalid': 'Enter a client ID without spaces',
	'mc.new.clientIdTaken': 'This client ID is already in use',
	'mc.new.reachNoTenants': 'Choose at least one tenant',
	'mc.new.permissionsInvalid': 'One of the permissions is not valid',
	'mc.new.ttlRange': 'The token lifetime must be a whole number from 1 to {max} seconds',

	'mc.d.back': 'Back to machine access',
	'mc.d.notFound': 'This machine was not found',
	'mc.d.loadFailed': 'The machine could not be loaded',
	'mc.d.disabledNote': 'This machine is disabled. It cannot sign in, even though it has keys.',
	'mc.d.deletedNote':
		'This machine was deleted. It cannot be changed or brought back from this screen.',
	'mc.d.overview': 'Machine',
	'mc.d.status': 'Status',
	'mc.d.edit': 'Edit',
	'mc.d.edit.title': 'Machine settings',
	'mc.d.edit.save': 'Save',
	'mc.d.enable': 'Enable',
	'mc.d.disable': 'Disable',
	'mc.d.disable.title': 'Disable this machine?',
	'mc.d.disable.body':
		'A disabled machine cannot sign in, even though its keys stay as they are. You can enable it again later (that asks for an additional identity check).',
	'mc.d.advancedDesc': 'Description, type and token lifetime',
	'mc.d.none': 'None',
	'mc.d.ttlValue': '{seconds} seconds',
	'mc.d.updated': 'Updated',
	'mc.d.access': 'Permissions and tenants',
	'mc.d.accessDesc': 'What this machine may do, and in which tenants.',
	'mc.d.access.title': 'Change permissions and tenants',
	'mc.d.access.note':
		'This hands out access, so saving may ask for an additional identity check (step-up).',
	'mc.d.noPermissions': 'No permissions yet',

	'mc.key.title': 'Signing keys',
	'mc.key.desc':
		'A machine signs in with a proof signed by its own private key. Authrim keeps only the public key. To replace a key, add the new one first, then revoke the old one.',
	'mc.key.add': 'Add key',
	'mc.key.empty': 'No keys',
	'mc.key.emptyBody': 'Add a public key so this machine can sign in.',
	'mc.key.col.kid': 'Key ID (kid)',
	'mc.key.col.alg': 'Algorithm',
	'mc.key.col.status': 'Status',
	'mc.key.col.expires': 'Expires',
	'mc.key.col.actions': 'Actions',
	'mc.key.status.active': 'Active',
	'mc.key.status.rotating': 'Being replaced',
	'mc.key.status.revoked': 'Revoked',
	'mc.key.status.expired': 'Expired',
	'mc.key.status.notYet': 'Not yet valid',
	'mc.key.noEnd': 'No expiry',
	'mc.key.revoke': 'Revoke',
	'mc.key.revokeTitle': 'Revoke key {kid}?',
	'mc.key.revokeBody': 'The machine can no longer sign in with this key. This cannot be undone.',

	'mc.key.new.title': 'Add a key',
	'mc.key.new.submit': 'Add',
	'mc.key.new.note':
		'Paste the public key only. Never send the private key to Authrim; keep it on the machine. The key uses the machine’s own permissions and tenants.',
	'mc.key.kid': 'Key ID (kid)',
	'mc.key.kidHint': 'A name for the key. It must match the kid the machine signs with.',
	'mc.key.kidRequired': 'Enter a key ID',
	'mc.key.kidTaken': 'This machine already has a key with this ID',
	'mc.key.jwk': 'Public key (JWK)',
	'mc.key.jwkHint': 'Paste JSON shaped like { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" }.',
	'mc.key.advancedDesc': 'Algorithm, key name and expiry. You usually do not need to change these.',
	'mc.key.alg': 'Algorithm',
	'mc.key.algAuto': 'Work it out from the key',
	'mc.key.algHint': 'ES256, PS256 and RS256 are supported.',
	'mc.key.name': 'Key name',
	'mc.key.nameHint': 'Left empty, the key ID is used.',
	'mc.key.days': 'Valid for',
	'mc.key.daysUnit': 'days',
	'mc.key.daysHint': 'Left empty, the key does not expire.',
	'mc.key.daysInvalid': 'The number of days must be a whole number of 1 or more',

	'mc.key.jwk.empty': 'Paste the public key',
	'mc.key.jwk.notJson': 'This is not valid JSON. Paste it exactly as is, from { to }',
	'mc.key.jwk.notObject': 'The key must be a JSON object in { }',
	'mc.key.jwk.private':
		'This contains private key members (d, p, q…). Paste the public key only. Keep this key secret and do not send it',
	'mc.key.jwk.keyType': 'This key type is not supported. Use an EC (P-256) or RSA public key',
	'mc.key.jwk.algorithm': 'The key type does not match the algorithm',
	'mc.key.jwk.use': 'Use a signing key (use set to sig)',
	'mc.key.jwk.keyOps': 'key_ops that allow signing or decrypting are not accepted',

	'mc.toast.created': '{name} was registered. Next, add its public key',
	'mc.toast.saved': 'Saved',
	'mc.toast.enabled': 'Enabled',
	'mc.toast.disabled': 'Disabled',
	'mc.toast.keyAdded': 'Key {kid} was added',
	'mc.toast.keyRevoked': 'Key {kid} was revoked',

	'mc.error.cancelled': 'The identity check was cancelled, so nothing was sent.',
	'mc.error.capabilityOff':
		'The platform has switched off handing out new machine keys and permissions.',
	'mc.error.invalid':
		'The request was not accepted. You may not be allowed to hand out one of these permissions or tenants. Check the values.',
	'mc.error.forbidden': 'You do not have permission to do this.',
	'mc.error.notFound': 'The machine was not found. Go back to the list to check.',
	'mc.error.conflict':
		'That name is already in use, or someone else changed it first. Load it again and check.',
	'mc.error.generic': 'It could not be saved. Try again.'
};
