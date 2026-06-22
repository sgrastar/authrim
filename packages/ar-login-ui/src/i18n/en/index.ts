import type { BaseTranslation } from '../i18n-types';

const en = {
	app_title: 'Authrim',
	app_subtitle: 'OpenID Connect Provider on Cloudflare Workers',
	button_openDialog: 'Open Dialog',
	dialog_title: 'Melt UI Dialog',
	dialog_description:
		'This is a test dialog using Melt UI, a headless, accessible component library for Svelte.',
	dialog_cancel: 'Cancel',
	dialog_confirm: 'Confirm',
	dialog_close: 'Close',
	//footer_stack: 'SvelteKit v5 + UnoCSS + Melt UI + Cloudflare Workers',
	footer_stack: 'Powered by Authrim',
	language_switch: 'Switch Language',
	language_english: 'English',
	language_japanese: '日本語',
	theme_switchToLightMode: 'Switch to light mode',
	theme_switchToDarkMode: 'Switch to dark mode',

	common_email: 'Email address',
	common_emailPlaceholder: 'you@example.com',
	common_name: 'Full name',
	common_namePlaceholder: 'John Doe',
	common_continue: 'Continue',
	common_backToLogin: 'Back to login',
	common_or: 'or',
	common_loading: 'Loading...',
	common_userFallback: 'User',

	account_pageTitle: 'Account - Authrim',
	account_title: 'Account',
	account_profileTitle: 'Profile',
	account_securityTitle: 'Security',
	account_name: 'Name',
	account_email: 'Email',
	account_manage: 'Manage',
	account_passkeys: 'Passkeys',
	account_socialAccounts: 'Social accounts',

	login_title: 'Welcome back',
	login_subtitle: 'Sign in to your account',
	login_signInWithPasskey: 'Sign in with Passkey',
	login_sendCode: 'Send verification code',
	login_signInWithDirectory: 'Sign in with {label:string}',
	login_directoryUsernamePlaceholder: 'username',
	login_directoryPasswordLabel: 'Password',
	login_directoryPasswordPlaceholder: 'Password',
	login_createAccount: "Don't have an account? Create one",
	login_errorEmailRequired: 'Email address is required',
	login_errorEmailInvalid: 'Please enter a valid email address',
	login_errorDirectoryUsernameRequired: 'Username is required',
	login_errorDirectoryPasswordRequired: 'Password is required',
	login_errorDirectoryInvalidCredentials: 'The username or password is incorrect',
	login_errorDirectoryUnavailable: 'Directory sign-in is temporarily unavailable',
	login_errorDirectoryUnmapped: 'This directory account is not mapped to an Authrim user',
	login_errorDirectoryFailed: 'Directory sign-in failed',
	login_orContinueWith: 'Or continue with',
	login_continueWith: 'Continue with {provider:string}',
	login_humanVerificationLoading: 'Loading security check...',
	login_humanVerificationLoadFailed:
		'Security check could not be loaded. Reload the page and try again.',
	login_noMethodsAvailable:
		'No authentication method is enabled for this tenant. Contact your administrator.',

	discover_pageTitle: 'Tenant Discovery',
	discover_kicker: 'Tenant discovery',
	discover_title: 'Find your tenant',
	discover_subtitle:
		'Resolve the correct tenant first. Authentication methods are loaded after the tenant is confirmed.',
	discover_notice_disabled:
		'This entry point is disabled for this tenant. Use the tenant-specific login URL instead.',
	discover_notice_manualOnly:
		'Automatic tenant discovery is disabled. Enter your tenant code or tenant slug to continue.',
	discover_recentTenant: 'Recent tenant',
	discover_methodLabel: 'Discovery method',
	discover_method_email: 'Email address',
	discover_method_tenantCode: 'Tenant code',
	discover_method_tenantSlug: 'Tenant slug',
	discover_placeholder_email: 'you@example.com',
	discover_placeholder_tenantCode: 'acme',
	discover_placeholder_tenantSlug: 'acme-corp',
	discover_selectTenant: 'Select a tenant',
	discover_error_emailNotFound: 'No account matched that email address.',
	discover_error_emailDomainNotFound: 'This email domain is not mapped to a tenant.',
	discover_error_tenantCodeNotFound: 'No tenant matched that tenant code.',
	discover_error_tenantSlugNotFound: 'No tenant matched that tenant slug.',
	discover_error_invitationNotFound: 'This invitation is invalid or has expired.',
	discover_error_appHintNotFound: 'No tenant matched that application hint.',
	discover_error_notFound: 'No tenant could be resolved.',
	discover_error_valueRequired: 'A value is required.',
	discover_error_manualRequired:
		'Tenant could not be resolved automatically. Enter your tenant code or tenant slug to continue.',
	discover_error_invitationUnresolved: 'The invitation could not be resolved.',
	discover_error_resolveFailed: 'Failed to resolve tenant',

	header_signUp: 'Sign Up',
	header_login: 'Login',
	header_logout: 'Logout',

	landing_metaDescription:
		'Authrim - A modern OpenID Connect Provider built with Cloudflare Workers.',
	landing_providerBadge: 'OpenID Connect Provider',
	landing_signedInAs: 'Signed in as',

	register_title: 'Create your account',
	register_subtitle: 'Get started with Authrim',
	register_createWithPasskey: 'Create Account with Passkey',
	register_sendCode: 'Sign up with verification code',
	register_alreadyHaveAccount: 'Already have an account? Sign in',
	register_termsAgreement:
		'By creating an account, you agree to our Terms of Service and Privacy Policy',
	register_noMethodsAvailable:
		'No signup method is enabled for this tenant. Contact your administrator.',

	emailCode_title: 'Check your email',
	emailCode_subtitle: "We've sent a verification code to",
	emailCode_instructions:
		'Enter the 6-digit code from your email. The code will expire in 5 minutes.',
	emailCode_codeLabel: 'Verification Code',
	emailCode_verifyButton: 'Verify',
	emailCode_resendButton: 'Resend code',
	emailCode_resendTimer: 'Resend in {seconds}s',
	emailCode_resendSuccess: 'Code sent successfully',
	emailCode_success: 'Verification successful! Redirecting...',
	emailCode_errorInvalid: 'Invalid or expired code',

	consent_title: '{clientName:string} wants to access your account',
	consent_subtitle: 'This application is requesting access to your Authrim account',
	consent_scopesTitle: 'This application will be able to:',
	consent_userInfo: 'You are signed in as',
	consent_notYou: 'Not you? Switch account',
	consent_allowButton: 'Allow',
	consent_denyButton: 'Deny',
	consent_privacyPolicy: 'Privacy Policy',
	consent_termsOfService: 'Terms of Service',

	consent_scope_openid: 'Verify your identity',
	consent_scope_profile: 'View your profile information (name, picture)',
	consent_scope_email: 'View your email address',
	consent_scope_phone: 'View your phone number',
	consent_scope_address: 'View your address',
	consent_scope_offline_access: "Maintain access when you're not using the app",

	consent_organizationSelect: 'Select organization',
	consent_primaryOrg: 'Primary',
	consent_currentOrganization: 'Current organization',
	consent_actingOnBehalfOf: 'Acting on behalf of {name:string}',
	consent_delegatedAccess: 'Delegated Access',
	consent_delegatedAccessWarning:
		"You are authorizing this application to access {name}'s account on their behalf",
	consent_yourRoles: 'Your roles',
	consent_trustedClient: 'Trusted application',

	consent_items_required_title: 'Required consents',
	consent_items_optional_title: 'Optional consents',
	consent_item_view_document: 'View document',
	consent_item_version_updated: '{oldVersion:string} → {newVersion:string} updated',
	consent_item_required_badge: 'Required',
	consent_item_optional_badge: 'Optional',
	consent_item_processing_purpose: 'Processing purpose',
	consent_item_withdrawal_impact: 'Withdrawal impact',
	consent_delete_account_link: 'Request account deletion',
	consent_block_message:
		'You must agree to all required consent items to continue. If you do not agree, you may request account deletion.',

	error_title: 'Oops! Something went wrong',
	error_subtitle: 'We encountered an error while processing your request',
	error_contactSupport: 'If this problem persists, please contact support',
	error_errorCode: 'Error code',

	error_invalid_request: 'The request is missing a required parameter or is otherwise malformed',
	error_access_denied: 'You denied the authorization request',
	error_unauthorized_client: 'The client is not authorized to request an authorization code',
	error_unsupported_response_type: 'The authorization server does not support this response type',
	error_invalid_scope: 'The requested scope is invalid, unknown, or malformed',
	error_server_error: 'The authorization server encountered an unexpected error',
	error_temporarily_unavailable:
		'The authorization server is temporarily unable to handle the request',
	error_login_required: 'Authentication required. Please sign in to continue.',
	error_unknown: 'An unknown error occurred',

	device_title: 'Device Verification',
	device_subtitle: 'Enter the code shown on your device',
	device_codeLabel: 'Verification Code',
	device_codePlaceholder: 'XXXX-XXXX',
	device_codeHint: 'Enter the 8-character code from your device (format: XXXX-XXXX)',
	device_verifyButton: 'Verify Code',
	device_confirmTitle: 'Authorize Device',
	device_requestedPermissions: 'Requested permissions',
	device_approveButton: 'Approve',
	device_denyButton: 'Deny',
	device_success: 'Device authorized successfully! You can now close this window.',
	device_errorInvalidCode: 'Invalid or expired verification code',
	device_errorInvalidOrExpiredCode: 'Invalid or expired code',
	device_errorVerifyFailed: 'Failed to verify device code',
	device_errorApproveFailed: 'Failed to approve device',
	device_errorDenyFailed: 'Failed to deny device',
	device_errorInvalidRedirect: 'Invalid redirect URL received from server',

	ciba_title: 'Authentication Request',
	ciba_subtitle: 'An application is requesting your approval',
	ciba_noPendingRequests: 'No pending authentication requests',
	ciba_noPendingDescription: "You don't have any pending authentication requests at the moment.",
	ciba_bindingMessage: 'Verification message',
	ciba_authenticationRequest: 'Authentication Request',
	ciba_expiresIn: 'Expires in',
	ciba_verificationCode: 'Verification Code',
	ciba_requestedAccess: 'Requested Access',
	ciba_approveButton: 'Approve',
	ciba_rejectButton: 'Reject',
	ciba_approvedSuccess: 'Request approved successfully',
	ciba_rejectedSuccess: 'Request rejected',
	ciba_expired: 'Expired',
	ciba_refresh: 'Refresh',
	ciba_errorLoadPending: 'Failed to load pending requests',
	ciba_errorGeneric: 'An error occurred',
	ciba_errorApproveFailed: 'Failed to approve request',
	ciba_errorDenyFailed: 'Failed to deny request',

	reauth_title: 'Verify Your Identity',
	reauth_subtitle: 'For security, please re-authenticate to continue',
	reauth_verifyWithPasskey: 'Verify with Passkey',
	reauth_verifyWithEmailCode: 'Verify with Email Code',

	callback_title: 'Signing In',
	callback_processing: 'Processing authentication...',
	callback_pleaseWait: 'Please wait while we complete your sign-in.',
	callback_success: 'Sign-in successful!',
	callback_redirecting: 'Redirecting you now...',
	callback_errorTitle: 'Authentication Failed',
	callback_errorMissingCode: 'No authorization code received. Please try signing in again.',

	common_backToHome: 'Back to home',

	// External IdP error messages (login page)
	login_extError_accountExists_title: 'Account Already Exists',
	login_extError_accountExists_message:
		'An account with this email already exists. Please log in with your existing credentials first.',
	login_extError_accountExists_action:
		'After logging in, you can link your external account from the settings page.',
	login_extError_emailNotVerified_title: 'Email Not Verified',
	login_extError_emailNotVerified_message:
		'The email from your external account is not verified. Please verify your email with the provider first.',
	login_extError_localEmailNotVerified_title: 'Verify Your Email',
	login_extError_localEmailNotVerified_message:
		'Your existing account email is not verified. Please verify your email first before linking external accounts.',
	login_extError_jitDisabled_title: 'Registration Not Available',
	login_extError_jitDisabled_message:
		'New account registration via external providers is not available. Please register with email first or contact your administrator.',
	login_extError_noAccount_title: 'No Account Found',
	login_extError_noAccount_message: 'No account was found. Please register first.',
	login_extError_providerError_title: 'Provider Error',
	login_extError_providerError_message:
		'The external provider returned an error. Please try again later.',
	login_extError_callbackFailed_title: 'Authentication Failed',
	login_extError_callbackFailed_message:
		'An error occurred during authentication. Please try again.',
	login_extError_default_title: 'Authentication Error',
	login_extError_default_message: 'An error occurred during external authentication.',

	// Login page client info
	login_signingInTo: 'Signing in to',

	// Common (shared)
	common_contactSupport: 'Contact Support',
	common_dismissAlert: 'Dismiss alert',

	// Accessibility
	emailCode_digitLabel: 'Digit {position:number} of 6'
} satisfies BaseTranslation;

export default en;
