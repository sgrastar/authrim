export type ScreenKind =
  | 'registration'
  | 'profile_completion'
  | 'login'
  | 'consent'
  | 'code_input'
  | 'account'
  | 'custom';
export type ScreenBlockType =
  | 'identity_field'
  | 'auth_widget'
  | 'guest_login_widget'
  /**
   * The link to the other sign-in screen: from sign in to sign up ("Don't have an account?") and
   * back ("Already have an account?"). The page decides where it goes; the part decides where on
   * the screen it sits, and what it says (its label, empty for the standard wording).
   */
  | 'auth_switch_link'
  | 'code_input_widget'
  | 'consent_widget'
  | 'heading'
  | 'text'
  | 'security_verification'
  | 'divider'
  | 'layout_row'
  | 'link'
  /** A choice from a list (a drop-down). */
  | 'select'
  /** A choice from a list, every option on screen. */
  | 'radio'
  /** A yes/no answer. */
  | 'checkbox'
  | 'account_upgrade_widget'
  | 'account_profile_widget'
  | 'account_device_list_widget'
  | 'account_session_widget'
  | 'account_passkey_widget'
  | 'account_totp_widget'
  | 'account_consent_widget'
  | 'account_activity_widget'
  | 'account_social_account_widget'
  | 'account_launcher_widget';

/**
 * The legacy way to ask a yes/no question: an `identity_field` with `value_type: 'boolean'`. Saved
 * screens are rewritten to a `checkbox` block; the run time still reads both.
 */
export type ScreenValueType = 'text' | 'boolean';

/** Where the answer to a part that is not stored to the profile goes (one or both). */
export type ScreenAnswerTarget = 'flow_event' | 'record';
export const SCREEN_ANSWER_TARGETS: readonly ScreenAnswerTarget[] = ['flow_event', 'record'];

/** A choice of a `select` or `radio` part that is not stored to the profile. */
export interface ScreenFieldOption {
  value: string;
  label: string;
}

/** The input parts: what a person answers on a screen. */
export const SCREEN_INPUT_BLOCK_TYPES = ['identity_field', 'select', 'radio', 'checkbox'] as const;
/** The input parts whose answers are a choice from a list. */
export const SCREEN_CHOICE_BLOCK_TYPES = ['select', 'radio'] as const;
export const MAX_SCREEN_FIELD_OPTIONS = 100;
export const MAX_SCREEN_OPTION_VALUE_LENGTH = 128;
export const MAX_SCREEN_OPTION_LABEL_LENGTH = 100;
export type ScreenLinkStyle = 'text' | 'button';
export const SCREEN_LINK_STYLES: readonly ScreenLinkStyle[] = ['text', 'button'];
/**
 * What a `link` part does. `url` opens its `href`; the others leave the screen by one of its
 * exits, and where an exit leads is the Flow's to decide (an edge from that handle of the screen
 * node), not the screen's: `next` submits the screen (handle `submitted`), `skip` leaves it
 * without its answers (`skipped`), `exit` leaves it by an exit of its own name (`link_exit`), and
 * `back` returns to the screen shown before it.
 */
export type ScreenLinkAction = 'url' | 'next' | 'back' | 'skip' | 'exit';
export const SCREEN_LINK_ACTIONS: readonly ScreenLinkAction[] = [
  'url',
  'next',
  'back',
  'skip',
  'exit',
];
/** An exit's name, as a link part gives it and the Flow's edge names the handle. */
export const SCREEN_LINK_EXIT_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;
/** The handles a screen node has of its own: no exit may take their names. */
export const SCREEN_RESERVED_EXITS: readonly string[] = ['submitted', 'skipped', 'next'];

/**
 * The exits a screen's link parts add to the screen node's own (`submitted`, and `skipped` when a
 * part skips), in the order they first appear. Read from saved fields, so only well-formed names.
 */
export function screenLinkExits(
  fields: readonly Pick<
    ScreenField,
    'block_type' | 'link_action' | 'link_exit' | 'display_condition'
  >[]
): string[] {
  const exits: string[] = [];
  // A part never shown offers no way out: hidden itself, or in a hidden row (a row's condition
  // holds for the parts after it, up to the next row, as the Login UI draws them).
  let rowHidden = false;
  for (const field of fields) {
    if (field.block_type === 'layout_row') {
      rowHidden = field.display_condition?.mode === 'hidden';
      continue;
    }
    if (field.block_type !== 'link' || rowHidden || field.display_condition?.mode === 'hidden') {
      continue;
    }
    const exit =
      field.link_action === 'skip'
        ? 'skipped'
        : field.link_action === 'exit' &&
            typeof field.link_exit === 'string' &&
            SCREEN_LINK_EXIT_PATTERN.test(field.link_exit) &&
            !SCREEN_RESERVED_EXITS.includes(field.link_exit)
          ? field.link_exit
          : null;
    if (exit && !exits.includes(exit)) exits.push(exit);
  }
  return exits;
}
export type ScreenCanvasLayout = 'narrow' | 'wide';
export type ScreenHumanVerificationTiming = 'initial' | 'submit';
export type ScreenDisplayConditionMode = 'always' | 'feature_enabled' | 'hidden';
export type ScreenDisplayConditionFeature =
  | 'passkey'
  | 'mail_otp'
  | 'mail_otp_totp'
  | 'totp'
  | 'external_idp'
  | 'directory_password';

export interface ScreenDisplayCondition {
  mode: ScreenDisplayConditionMode;
  feature?: ScreenDisplayConditionFeature | null;
}

export interface ScreenSettings {
  canvas_layout?: ScreenCanvasLayout;
  base_preset_key?: string;
  base_preset_version?: number;
}

export interface ScreenField {
  field: string;
  label: string;
  required: boolean;
  block_type?: ScreenBlockType;
  block_id?: string;
  value_type?: ScreenValueType | null;
  auth_method?: string | null;
  code_input_mode?: 'auto' | 'mail_otp' | 'totp' | null;
  external_idp_show_action_text?: boolean | null;
  text?: string | null;
  help_text?: string | null;
  placeholder?: string | null;
  /** A `link` part whose action is `url` (the default): where it goes. */
  href?: string | null;
  /**
   * A `link` part: what it does (`url` when absent). Only `url` has a destination of its own;
   * the others name an exit of the screen, which the Flow connects.
   */
  link_action?: ScreenLinkAction | null;
  /** A `link` part whose action is `exit`: the exit's name (`SCREEN_LINK_EXIT_PATTERN`). */
  link_exit?: string | null;
  /** A `link` part: drawn as a text link (the default) or as a button. */
  link_style?: ScreenLinkStyle | null;
  human_verification_timing?: ScreenHumanVerificationTiming | null;
  display_condition?: ScreenDisplayCondition | null;
  layout_columns?: number | null;
  layout_column?: number | null;
  order?: number;
  /** Input parts: whether the label is shown (a hidden one is still read out). Default true. */
  show_label?: boolean;
  /**
   * Input parts: whether the answer is the user's attribute named by `field` (default true). When
   * false, `field` is the answer's own key, and `answer_targets` says where the answer goes.
   */
  store_to_profile?: boolean;
  /** Only when `store_to_profile` is false: one or both. */
  answer_targets?: ScreenAnswerTarget[];
  /**
   * Only for a `select` or `radio` part not stored to the profile. A part stored to the profile
   * takes its choices from the attribute's Identity Schema at run time (none are saved here).
   */
  options?: ScreenFieldOption[];
}

export interface ScreenLocalization {
  display_name?: string;
  description?: string;
  fields?: Record<
    string,
    Partial<Pick<ScreenField, 'label' | 'text' | 'help_text' | 'placeholder'>> & {
      /** The labels of a part's own options (not stored to the profile), by option value. */
      options?: Record<string, string>;
    }
  >;
}

export interface Screen {
  id: string;
  tenant_id: string;
  screen_key: string;
  display_name: string;
  description?: string | null;
  screen_kind: ScreenKind;
  fields_json: string | ScreenField[];
  localizations_json?: string | Record<string, ScreenLocalization> | null;
  settings_json?: string | ScreenSettings | null;
  is_active: number | boolean;
  is_system: number | boolean;
  /** Optimistic-concurrency counter: a change must name it (If-Match), and raises it by one. */
  version?: number;
  created_at: number;
  updated_at: number;
}

export interface ScreenResponse extends Omit<
  Screen,
  'fields_json' | 'localizations_json' | 'settings_json'
> {
  fields: ScreenField[];
  localizations: Record<string, ScreenLocalization>;
  settings: ScreenSettings;
  version: number;
}

/** Where a screen is used: a flow node that shows it, or an account page that places it. */
export type ScreenUsage =
  | {
      kind: 'flow';
      flow_id: string;
      flow_name: string;
      node_id: string | null;
      node_title: string | null;
      /**
       * In the flow's draft, in the version it has published, or in an older published version
       * that sign-ins in progress still run.
       */
      stage: 'draft' | 'published' | 'running';
    }
  | { kind: 'account_page'; page_id: string | null; page_name: string };

export type AccountPagePlacementWidth = 'full' | 'half';

export type AccountPageVisibilityCondition =
  | 'always'
  | 'hidden'
  | 'passkey_enabled'
  | 'totp_enabled'
  | 'external_idp_enabled'
  | 'consent_records_available'
  | 'multiple_sessions';

export interface AccountPageScreenPlacement {
  id: string;
  screen_key: string;
  width: AccountPagePlacementWidth;
  enabled: boolean;
  condition: AccountPageVisibilityCondition;
  show_for_guests: boolean;
}

export interface AccountPageLocalization {
  title?: string;
  description?: string;
}

export interface AccountPageDefinition {
  schema_version: 'authrim.account_page.v1';
  base_preset_id?: 'authrim-default';
  base_preset_version?: number;
  title?: string;
  description?: string;
  localizations?: Record<string, AccountPageLocalization>;
  screens: AccountPageScreenPlacement[];
}

export interface PublishedAccountPageDefinition extends AccountPageDefinition {
  resolved_at: string;
  screen_snapshots: Record<string, ScreenResponse>;
}

export interface AccountPageRecord {
  id: string;
  name: string;
  base_preset_id: 'authrim-default';
  base_preset_version: number;
  draft: AccountPageDefinition;
  published?: PublishedAccountPageDefinition;
  rollback?: PublishedAccountPageDefinition;
  published_version: number;
  published_at: string;
  created_at: number;
  updated_at: number;
}

export interface AccountPagesDocument {
  schema_version: 'authrim.account_pages.v1';
  default_page_id: string | null;
  pages: AccountPageRecord[];
}

export const ACCOUNT_PAGE_PRESET_VERSION = 3;

/** Account screens created for each tenant and editable from the screen list. */
export const DEFAULT_ACCOUNT_SCREEN_KEYS = [
  'account_overview',
  'account_launchers',
  'account_profile',
  'account_devices',
  'account_sessions',
  'account_passkeys',
  'account_totp',
  'account_consents',
  'account_activity',
  'account_social_accounts',
  'account_custom',
] as const;

/** Tenant screens created on first use while their built-in templates remain immutable. */
export const EDITABLE_DEFAULT_SCREEN_KEYS = [
  'registration',
  'login',
  'consent',
  'code_input',
  ...DEFAULT_ACCOUNT_SCREEN_KEYS,
] as const;

export const DEFAULT_ACCOUNT_PAGE_DEFINITION: AccountPageDefinition = {
  schema_version: 'authrim.account_page.v1',
  base_preset_id: 'authrim-default',
  base_preset_version: ACCOUNT_PAGE_PRESET_VERSION,
  screens: [
    {
      id: 'overview',
      screen_key: 'account_overview',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'launchers',
      screen_key: 'account_launchers',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'profile',
      screen_key: 'account_profile',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'devices',
      screen_key: 'account_devices',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'sessions',
      screen_key: 'account_sessions',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'passkeys',
      screen_key: 'account_passkeys',
      width: 'half',
      enabled: true,
      condition: 'passkey_enabled',
      show_for_guests: true,
    },
    {
      id: 'totp',
      screen_key: 'account_totp',
      width: 'full',
      enabled: true,
      condition: 'totp_enabled',
      show_for_guests: true,
    },
    {
      id: 'consents',
      screen_key: 'account_consents',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'activity',
      screen_key: 'account_activity',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
  ],
};
