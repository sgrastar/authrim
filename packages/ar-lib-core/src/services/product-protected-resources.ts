export interface ProductProtectedResourceDefinition {
  resourceClass: string;
  defaultAudience: string;
  routePathTemplate: string;
  defaultDetailClasses: string[];
  servicePackage: string;
}

export const PRODUCT_PROTECTED_RESOURCE_DEFINITIONS: Record<
  string,
  ProductProtectedResourceDefinition
> = {
  customer_profile: {
    resourceClass: 'customer_profile',
    defaultAudience: 'svc://op-userinfo/customer-profile',
    routePathTemplate: '/api/protected/customer-profiles/:userId',
    defaultDetailClasses: ['profile_export'],
    servicePackage: '@authrim/ar-userinfo',
  },
  verified_attribute: {
    resourceClass: 'verified_attribute',
    defaultAudience: 'svc://op-vc/attribute-elevation',
    routePathTemplate: '/vp/attributes',
    defaultDetailClasses: ['verified_attribute_write'],
    servicePackage: '@authrim/ar-vc',
  },
};

export function getProductProtectedResourceDefinition(
  resourceClass: string | null | undefined
): ProductProtectedResourceDefinition | null {
  if (!resourceClass) {
    return null;
  }
  return PRODUCT_PROTECTED_RESOURCE_DEFINITIONS[resourceClass] ?? null;
}

export function resolveProductProtectedResourceAudience(input: {
  resourceClass: string | null | undefined;
  requestedAudience?: string | null | undefined;
}): string | null {
  if (input.requestedAudience?.trim()) {
    return input.requestedAudience.trim();
  }
  return getProductProtectedResourceDefinition(input.resourceClass)?.defaultAudience ?? null;
}

export function resolveProductProtectedResourceDetailClasses(input: {
  resourceClass: string | null | undefined;
  requestedDetailClasses?: string[] | null | undefined;
}): string[] {
  if (input.requestedDetailClasses?.length) {
    return input.requestedDetailClasses;
  }
  return getProductProtectedResourceDefinition(input.resourceClass)?.defaultDetailClasses ?? [];
}
