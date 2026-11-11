/** The standard sign-in every tenant is given (`flow-default-login-no-consent`), as seeded. */
export const SEEDED_LOGIN_EDITOR = {
	nodes: [
		{
			id: 'request',
			type: 'entry',
			title: 'Login Request',
			position: {
				x: 360,
				y: 0
			},
			config: {
				ui_kind: 'start'
			}
		},
		{
			id: 'session-check',
			type: 'session_check',
			title: 'Session Check',
			position: {
				x: 360,
				y: 144
			},
			config: {
				ui_kind: 'session'
			}
		},
		{
			id: 'authentication',
			type: 'authentication',
			title: 'Authentication Method',
			position: {
				x: 522,
				y: 288
			},
			config: {
				ui_kind: 'authentication',
				authentication_profile_ref: 'default',
				screen_ref: 'login',
				outputs: [
					{
						id: 'mail_otp',
						label: 'Email OTP'
					},
					{
						id: 'totp',
						label: 'Authenticator app'
					},
					{
						id: 'passkey',
						label: 'Passkey'
					},
					{
						id: 'facebook',
						label: 'Facebook'
					}
				]
			}
		},
		{
			id: 'saml-attribute-release-complete',
			type: 'complete',
			title: 'Complete',
			position: {
				x: 108,
				y: 612
			},
			config: {
				ui_kind: 'end',
				completion_block: {
					id: 'saml-attribute-release-completion',
					label: 'SAML Attribute Release Completion',
					protocol: 'saml',
					purpose: 'attribute_release',
					role: 'output'
				}
			}
		},
		{
			id: 'oidc-authorization-complete',
			type: 'complete',
			title: 'Complete',
			position: {
				x: 594,
				y: 612
			},
			config: {
				ui_kind: 'end',
				completion_block: {
					id: 'oidc-authorization-completion',
					label: 'OIDC Authorization Completion',
					protocol: 'oidc',
					purpose: 'authorization',
					role: 'output'
				}
			}
		}
	],
	edges: [
		{
			id: 'request:next->session-check',
			source: 'request',
			source_handle: 'next',
			target: 'session-check'
		},
		{
			id: 'session-check:continue->saml-attribute-release-complete',
			source: 'session-check',
			source_handle: 'continue',
			target: 'saml-attribute-release-complete'
		},
		{
			id: 'session-check:continue->oidc-authorization-complete',
			source: 'session-check',
			source_handle: 'continue',
			target: 'oidc-authorization-complete'
		},
		{
			id: 'session-check:authenticate->authentication',
			source: 'session-check',
			source_handle: 'authenticate',
			target: 'authentication'
		},
		{
			id: 'authentication:mail_otp->saml-attribute-release-complete',
			source: 'authentication',
			source_handle: 'mail_otp',
			target: 'saml-attribute-release-complete'
		},
		{
			id: 'authentication:mail_otp->oidc-authorization-complete',
			source: 'authentication',
			source_handle: 'mail_otp',
			target: 'oidc-authorization-complete'
		},
		{
			id: 'authentication:totp->saml-attribute-release-complete',
			source: 'authentication',
			source_handle: 'totp',
			target: 'saml-attribute-release-complete'
		},
		{
			id: 'authentication:totp->oidc-authorization-complete',
			source: 'authentication',
			source_handle: 'totp',
			target: 'oidc-authorization-complete'
		},
		{
			id: 'authentication:passkey->saml-attribute-release-complete',
			source: 'authentication',
			source_handle: 'passkey',
			target: 'saml-attribute-release-complete'
		},
		{
			id: 'authentication:passkey->oidc-authorization-complete',
			source: 'authentication',
			source_handle: 'passkey',
			target: 'oidc-authorization-complete'
		},
		{
			id: 'authentication:facebook->saml-attribute-release-complete',
			source: 'authentication',
			source_handle: 'facebook',
			target: 'saml-attribute-release-complete'
		},
		{
			id: 'authentication:facebook->oidc-authorization-complete',
			source: 'authentication',
			source_handle: 'facebook',
			target: 'oidc-authorization-complete'
		}
	],
	viewport: {
		x: 36,
		y: 36,
		zoom: 1
	}
};
