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
  /** The whole tile's background; null keeps the theme's card colour. */
  tile_background_color: string | null;
  /**
   * An image filling the tile's width (its height follows the image): an HTTPS URL or one of
   * this environment's uploaded launcher backgrounds (`/api/assets/<owner>/login-ui/
   * launcher-background/<file>`). Null: none.
   */
  background_image_url: string | null;
  /** The icon is not drawn (the tile shows only the image and, unless hidden, the name). */
  hide_icon: boolean;
  /** The name and description are not drawn; the name stays the tile's accessible name. */
  hide_name: boolean;
  grid_width: number;
  sort_order: number;
  enabled: boolean;
  allow_favorite: boolean;
  visibility: LauncherVisibility;
  created_at: number;
  updated_at: number;
}

/** Which tenants a platform launcher is shared with: none yet, every tenant, or the listed ones. */
export type PlatformLauncherShareMode = 'none' | 'all' | 'selected';

/**
 * A launcher the platform defines (admin database, environment data). It is a plain link
 * (`standalone`, `bookmark`) shown to everyone: it can name no tenant's application, user or
 * group. `tenant_change_allowed` off: a tenant may neither change nor hide it (a copy a tenant
 * made earlier is kept but set aside); it may still move it in its order.
 */
export interface PlatformLauncher extends ApplicationLauncher {
  share_mode: PlatformLauncherShareMode;
  /** The tenants it is shared with when `share_mode` is `selected` (empty otherwise). */
  tenant_ids: string[];
  tenant_change_allowed: boolean;
  version: number;
}

/** How a launcher a tenant lists stands to the platform (null: the tenant's own launcher). */
export interface SharedLauncherState {
  platform_version: number;
  tenant_change_allowed: boolean;
  /** The tenant changed it: what it shows is the tenant's copy (when change is allowed). */
  customized: boolean;
  /** The platform version the tenant's copy was made from (null: no copy). */
  customized_from_version: number | null;
  /** The platform changed it after the tenant's copy was made. */
  platform_updated: boolean;
}

/** A launcher in the tenant's list: its own, or one the platform shares with it. */
export interface TenantLauncherListItem extends ApplicationLauncher {
  shared: SharedLauncherState | null;
}

export interface AccountLauncher extends Omit<
  ApplicationLauncher,
  'application_type' | 'application_id' | 'launch_url' | 'deep_link_url' | 'visibility'
> {
  favorite: boolean;
  launch_href: string;
}
