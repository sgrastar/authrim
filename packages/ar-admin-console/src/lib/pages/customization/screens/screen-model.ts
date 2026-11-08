/**
 * What a screen is made of, as the screen builder and its preview work with it: parts in rows (see
 * `#lib/ui/builder/layout-model`), each part's settings, and each row's display condition.
 * `screen-layout.ts` turns a saved screen (`ScreenField[]`) into this and back.
 */
import type { IconName } from '#lib/ui/icons/icons.js';

export type PartGroup = 'content' | 'input' | 'signin' | 'account' | 'security';

/** The kind of every part the builder places, its group and its icon. */
export const PART_KINDS: readonly { kind: string; group: PartGroup; icon: IconName }[] = [
	{ kind: 'heading', group: 'content', icon: 'textH' },
	{ kind: 'text', group: 'content', icon: 'textAlignLeft' },
	{ kind: 'identity_field', group: 'input', icon: 'textbox' },
	{ kind: 'select', group: 'input', icon: 'caretUpDown' },
	{ kind: 'radio', group: 'input', icon: 'radio' },
	{ kind: 'checkbox', group: 'input', icon: 'checkSquare' },
	{ kind: 'link', group: 'content', icon: 'link' },
	{ kind: 'divider', group: 'content', icon: 'lineSegment' },
	{ kind: 'auth_widget', group: 'signin', icon: 'squaresFour' },
	{ kind: 'code_input_widget', group: 'signin', icon: 'password' },
	{ kind: 'consent_widget', group: 'input', icon: 'handshake' },
	{ kind: 'security_verification', group: 'signin', icon: 'shieldCheck' },
	{ kind: 'guest_login_widget', group: 'signin', icon: 'userCircleDashed' },
	{ kind: 'auth_switch_link', group: 'signin', icon: 'link' },
	{ kind: 'account_upgrade_widget', group: 'account', icon: 'userPlus' },
	{ kind: 'account_profile_widget', group: 'account', icon: 'userCircle' },
	{ kind: 'account_device_list_widget', group: 'security', icon: 'devices' },
	{ kind: 'account_session_widget', group: 'security', icon: 'monitor' },
	{ kind: 'account_passkey_widget', group: 'security', icon: 'key' },
	{ kind: 'account_totp_widget', group: 'security', icon: 'deviceMobile' },
	{ kind: 'account_consent_widget', group: 'account', icon: 'clipboardText' },
	{ kind: 'account_activity_widget', group: 'account', icon: 'history' },
	{ kind: 'account_social_account_widget', group: 'account', icon: 'link' },
	{ kind: 'account_launcher_widget', group: 'account', icon: 'rocket' }
];

export const partKind = (kind: string) => PART_KINDS.find((def) => def.kind === kind);

/** Kinds that take a display condition (rows take one too). */
export const CONDITION_KINDS: ReadonlySet<string> = new Set([
	'divider',
	'heading',
	'text',
	'identity_field',
	'select',
	'radio',
	'checkbox'
]);

/** Parts that ask for input and can fill in a user attribute. */
export const INPUT_KINDS: ReadonlySet<string> = new Set([
	'identity_field',
	'select',
	'radio',
	'checkbox'
]);

/** Input parts whose label can be hidden (a checkbox's label is its text, so it stays). */
export const LABEL_KINDS: ReadonlySet<string> = new Set(['identity_field', 'select', 'radio']);

/** Parts that offer choices: stored to the profile, their values come from an enum attribute. */
export const CHOICE_KINDS: ReadonlySet<string> = new Set(['select', 'radio']);

export const ACCOUNT_KINDS: ReadonlySet<string> = new Set(
	PART_KINDS.filter((def) => def.group === 'account' || def.group === 'security').map(
		(def) => def.kind
	)
);

export const METHODS = [
	'passkey',
	'mail_otp',
	'mail_otp_totp',
	'totp',
	'external_idp',
	'directory_password'
] as const;

export type Method = (typeof METHODS)[number];

export interface DisplayCondition {
	mode: 'always' | 'feature_enabled' | 'hidden';
	/** The feature that must be on (with `feature_enabled`). */
	feature: Method;
}

export type AnswerTarget = 'flow_event' | 'record';

export interface PartOption {
	value: string;
	label: string;
}

/**
 * Everything a part can be set to (each kind uses its own subset). Names in the comments are the
 * ScreenField properties they map to (`screen-layout.ts`).
 */
export interface PartSettings {
	/** display_condition */
	condition: DisplayCondition;
	/** Input parts: the answer is the user attribute `field` (store_to_profile). */
	linked: boolean;
	/** field: an Identity Schema key when linked, the answer's own key otherwise. */
	field: string;
	/** Input parts kept off the profile: where the answer goes (answer_targets, one or both). */
	answerTargets: AnswerTarget[];
	/** show_label (a hidden label is still read out). */
	showLabel: boolean;
	placeholder: string;
	/** select, radio when not linked (linked ones use the schema's values). */
	options: PartOption[];
	/** help_text */
	helpText: string;
	required: boolean;
	/** auth_method */
	method: Method;
	/** external_idp_show_action_text */
	actionText: boolean;
	/** code_input_mode */
	codeMode: 'auto' | 'mail_otp' | 'totp';
	/** heading (supporting text), text (body), code input and consent (description) */
	text: string;
	href: string;
	/** human_verification_timing */
	timing: 'initial' | 'submit';
}

export const defaultCondition = (): DisplayCondition => ({ mode: 'always', feature: 'passkey' });

export const defaultSettings = (overrides: Partial<PartSettings> = {}): PartSettings => ({
	condition: defaultCondition(),
	linked: true,
	field: 'email',
	answerTargets: ['flow_event'],
	showLabel: true,
	placeholder: '',
	options: [],
	helpText: '',
	required: false,
	method: 'passkey',
	actionText: false,
	codeMode: 'auto',
	text: '',
	href: '',
	timing: 'initial',
	...overrides
});

/** Mirrors custom_claim_schemas.field_type. */
export type SchemaType = 'String' | 'Number' | 'Boolean' | 'Date' | 'Enum';

/** An attribute a part can store its answer in, with its choices (labels in this language). */
export interface SchemaField {
	key: string;
	type: SchemaType;
	choices?: readonly PartOption[];
}

/** The attribute types a part can store: a checkbox yes/no, choices an enum, a field the rest. */
export const SCHEMA_TYPES_FOR: Readonly<Record<string, readonly SchemaType[]>> = {
	identity_field: ['String', 'Number', 'Date'],
	select: ['Enum'],
	radio: ['Enum'],
	checkbox: ['Boolean']
};

/** Whether a part can store its answer in an attribute. */
export const fieldFits = (kind: string, field: SchemaField) =>
	(SCHEMA_TYPES_FOR[kind] ?? []).includes(field.type);

/** Looks up an attribute's choices (by key), labelled in the current language. */
export type ChoiceSource = (key: string) => readonly PartOption[];

/** The options a choice part shows: the schema's when linked, its own otherwise. */
export const choicesOf = (
	settings: PartSettings | undefined,
	schemaChoices: ChoiceSource = () => []
): readonly PartOption[] =>
	!settings ? [] : settings.linked ? schemaChoices(settings.field) : settings.options;
