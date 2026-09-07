export type LauncherApplicationType = 'standalone' | 'oidc_client' | 'saml_sp';

export type LauncherLaunchType =
  | 'bookmark'
  | 'saml_sp_initiated'
  | 'oidc_third_party_initiated'
  | 'saml_idp_initiated';

export type LauncherIconType = 'phosphor' | 'image';
export type LauncherVisibilityMode = 'everyone' | 'users' | 'groups' | 'attributes';
export type LauncherAttributeMatch = 'all' | 'any';
export type LauncherAttributeOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'exists';

export interface LauncherAttributeRule {
  id: string;
  attribute_key: string;
  operator: LauncherAttributeOperator;
  attribute_value: string | null;
}

export interface LauncherVisibility {
  mode: LauncherVisibilityMode;
  attribute_match: LauncherAttributeMatch;
  user_ids: string[];
  group_ids: string[];
  attribute_rules: LauncherAttributeRule[];
}

export interface ApplicationLauncher {
  id: string;
  application_type: LauncherApplicationType;
  application_id: string | null;
  name: string;
  description: string | null;
  category: string | null;
  launch_type: LauncherLaunchType;
  launch_url: string | null;
  deep_link_url: string | null;
  open_in_new_tab: boolean;
  icon_type: LauncherIconType;
  icon_value: string;
  icon_color: string;
  background_color: string;
  grid_width: number;
  sort_order: number;
  enabled: boolean;
  allow_favorite: boolean;
  visibility: LauncherVisibility;
  created_at: number;
  updated_at: number;
}

export interface AccountLauncher extends Omit<
  ApplicationLauncher,
  'application_type' | 'application_id' | 'launch_url' | 'deep_link_url' | 'visibility'
> {
  favorite: boolean;
  launch_href: string;
}
