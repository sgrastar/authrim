# Lookup key distribution

Account lookup consumers must declare `lookupBlindIndex: true`, the `lookup` data
role, the `LOOKUP_DB` binding, and both `LOOKUP_HMAC_KEY_SLOT_A` and
`LOOKUP_HMAC_KEY_SLOT_B` in their Worker capability manifest. Keep the Setup data
roles, bootstrap bindings, and secret upload plan consistent with this declaration.
Slot B is optional before rotation; a slot referenced by the signed current or
previous key state must always be present and match that state's fingerprint.

Consumers are `ar-lib-core`, `ar-auth`, `ar-token`, `ar-userinfo`, `ar-management`,
`ar-saml`, `ar-bridge`, and `ar-vc`. Setup distributes rotation candidates to this
set. Control must verify candidate distribution and observe the activated
generation on every consumer before allowing the respective transition. Missing
or failed evidence from SAML, Bridge, or VC must block the transition just like
evidence from Auth or Token.

The Setup Lookup consumer contract test checks account lookup call sites against
the manifests and compares declarations, distribution, rotation, and Control's
verification target set. Control integration tests verify that omitting evidence
from any newly covered consumer prevents key activation.

## Diagnosing missing keys

`lookup_hmac_key_state_local_key_mismatch` means a referenced slot is absent or its
fingerprint differs from the verified key state. Inspect secret **names** first;
never print key values. Verify the environment, signature, expiry, generation
pointer, and local key fingerprint before distributing existing key material.
Check the physical Lookup database bindings too: adding a key alone cannot repair
a missing database binding. Preserve existing tenant/shard bindings and register
the consumer's Lookup role in Control inventory for future reconciliation.

The Admin DR Backup SAML bundle restores SAML signing keys and SAML settings. It
does not restore Lookup HMAC slots or configure Worker database bindings. Do not
regenerate Lookup keys or re-import SAML signing keys as a workaround for a missing
Lookup binding.

## September 2026 audit scope

The conformance audit compared Secret names on all 15 backend Workers with Setup's
required secret plan and traced account lookup and direct cryptographic secret
references. The missing required secrets were the active Lookup slot on SAML and
VC. Their Lookup database role and bootstrap binding declarations were also absent.
Control's verification set additionally omitted Bridge, although Setup already
distributed its keys.

Optional inactive rotation slots and optional provider credentials are not missing
required keys. Legacy Policy bearer credentials and Management's optional
Cloudflare automation credentials are separate opt-in paths; this repair does not
enable them or distribute broad Cloudflare credentials to runtime Workers. Shared
library environment references must be assessed at their actual Worker call sites,
not treated as dependencies of every Durable Object automatically.

Secret-name inventory does not prove that every unrelated secret value is correct.
The signed Lookup state and the existing conformance local active key were checked
for a matching fingerprint separately.
