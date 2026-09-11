/** Fields explicitly available to tenant-scoped account webhook integrations. */
export const ACCOUNT_WEBHOOK_FIELDS = ['email', 'registration_state'] as const;
export type AccountWebhookField = (typeof ACCOUNT_WEBHOOK_FIELDS)[number];

export function validateAccountWebhookFields(value: unknown): value is AccountWebhookField[] {
  return (
    Array.isArray(value) &&
    value.length <= ACCOUNT_WEBHOOK_FIELDS.length &&
    new Set(value).size === value.length &&
    value.every(
      (field) =>
        typeof field === 'string' && ACCOUNT_WEBHOOK_FIELDS.some((allowed) => allowed === field)
    )
  );
}

export function validateAccountRegistrationStates(
  value: unknown
): value is Array<'guest' | 'registered'> {
  return (
    Array.isArray(value) &&
    value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every((state) => state === 'guest' || state === 'registered')
  );
}
