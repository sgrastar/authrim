import type {
	Client,
	CreateClientInput,
	UpdateClientInput
} from '$lib/api/admin-clients'

export type DelegationMode = 'none' | 'delegation' | 'impersonation'

export interface ClientDownstreamGrantForm {
	token_exchange_allowed: boolean
	client_credentials_allowed: boolean
	delegation_mode: DelegationMode
	default_scope: string
	default_audience: string
	allowed_scopes: string
	allowed_subject_token_clients: string
	allowed_token_exchange_resources: string
}

export function createDefaultClientDownstreamGrantForm(): ClientDownstreamGrantForm {
	return {
		token_exchange_allowed: false,
		client_credentials_allowed: false,
		delegation_mode: 'delegation',
		default_scope: '',
		default_audience: '',
		allowed_scopes: '',
		allowed_subject_token_clients: '',
		allowed_token_exchange_resources: ''
	}
}

export function createPresetClientDownstreamGrantForm(presetId: string): ClientDownstreamGrantForm {
	const defaults = createDefaultClientDownstreamGrantForm()

	if (presetId === 'm2m-service') {
		return {
			...defaults,
			token_exchange_allowed: true,
			client_credentials_allowed: true
		}
	}

	return defaults
}

export function formatClientListForTextarea(values?: string[] | null): string {
	if (!values?.length) return ''
	return values.join('\n')
}

export function parseTextareaList(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

export function parseScopeRestrictionList(value: string): string[] {
	return value
		.split(/[\s,\n]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

export function buildClientDownstreamGrantFormFromClient(
	client: Pick<
		Client,
		| 'token_exchange_allowed'
		| 'client_credentials_allowed'
		| 'delegation_mode'
		| 'default_scope'
		| 'default_audience'
		| 'allowed_scopes'
		| 'allowed_subject_token_clients'
		| 'allowed_token_exchange_resources'
	>
): ClientDownstreamGrantForm {
	return {
		token_exchange_allowed: Boolean(client.token_exchange_allowed),
		client_credentials_allowed: Boolean(client.client_credentials_allowed),
		delegation_mode: client.delegation_mode ?? 'delegation',
		default_scope: client.default_scope ?? '',
		default_audience: client.default_audience ?? '',
		allowed_scopes: client.allowed_scopes?.join(' ') ?? '',
		allowed_subject_token_clients: formatClientListForTextarea(
			client.allowed_subject_token_clients ?? []
		),
		allowed_token_exchange_resources: formatClientListForTextarea(
			client.allowed_token_exchange_resources ?? []
		)
	}
}

export function downstreamGrantFormEquals(
	a: ClientDownstreamGrantForm | null,
	b: ClientDownstreamGrantForm | null
): boolean {
	if (!a || !b) return false

	return (
		a.token_exchange_allowed === b.token_exchange_allowed &&
		a.client_credentials_allowed === b.client_credentials_allowed &&
		a.delegation_mode === b.delegation_mode &&
		a.default_scope.trim() === b.default_scope.trim() &&
		a.default_audience.trim() === b.default_audience.trim() &&
		a.allowed_scopes.trim() === b.allowed_scopes.trim() &&
		a.allowed_subject_token_clients.trim() === b.allowed_subject_token_clients.trim() &&
		a.allowed_token_exchange_resources.trim() === b.allowed_token_exchange_resources.trim()
	)
}

export function toClientDownstreamGrantCreateInput(
	form: ClientDownstreamGrantForm
): Pick<
	CreateClientInput,
	| 'token_exchange_allowed'
	| 'client_credentials_allowed'
	| 'delegation_mode'
	| 'default_scope'
	| 'default_audience'
	| 'allowed_scopes'
	| 'allowed_subject_token_clients'
	| 'allowed_token_exchange_resources'
> {
	return {
		token_exchange_allowed: form.token_exchange_allowed,
		client_credentials_allowed: form.client_credentials_allowed,
		delegation_mode: form.delegation_mode,
		default_scope: form.default_scope.trim() || undefined,
		default_audience: form.default_audience.trim() || undefined,
		allowed_scopes: parseScopeRestrictionList(form.allowed_scopes),
		allowed_subject_token_clients: parseTextareaList(form.allowed_subject_token_clients),
		allowed_token_exchange_resources: parseTextareaList(form.allowed_token_exchange_resources)
	}
}

export function toClientDownstreamGrantUpdateInput(
	form: ClientDownstreamGrantForm
): Pick<
	UpdateClientInput,
	| 'token_exchange_allowed'
	| 'client_credentials_allowed'
	| 'delegation_mode'
	| 'default_scope'
	| 'default_audience'
	| 'allowed_scopes'
	| 'allowed_subject_token_clients'
	| 'allowed_token_exchange_resources'
> {
	return {
		token_exchange_allowed: form.token_exchange_allowed,
		client_credentials_allowed: form.client_credentials_allowed,
		delegation_mode: form.delegation_mode,
		default_scope: form.default_scope.trim() || null,
		default_audience: form.default_audience.trim() || null,
		allowed_scopes: parseScopeRestrictionList(form.allowed_scopes),
		allowed_subject_token_clients: parseTextareaList(form.allowed_subject_token_clients),
		allowed_token_exchange_resources: parseTextareaList(form.allowed_token_exchange_resources)
	}
}
