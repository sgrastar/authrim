# Directory Authentication Public Summary

This document summarizes Authrim Directory Authentication and Authrim Wordwarden for customer security and compliance reviews.

## Scope

Directory Authentication lets a tenant authenticate users against an existing LDAP or Active Directory directory through Authrim Wordwarden. Authrim does not store user passwords or password hashes for this feature. Wordwarden verifies the password against the customer-controlled directory and returns only the verification result and configured non-secret attributes.

Supported authentication paths are:

- Passkey
- Email Code
- Directory Connector
- External IdP

## Trust Boundary

Wordwarden runs in the customer-controlled environment near LDAP or Active Directory. Authrim calls Wordwarden over a configured connector path, or Wordwarden connects to Authrim Relay for outbound-only deployments.

The directory password is handled only by Wordwarden for the verification request. Authrim receives success or failure, selected directory facts, connector identifiers, and operational metadata needed for audit and support.

## Data Handling

Authrim stores tenant-scoped Directory Authentication configuration, connector inventory, migration state, audit events, support bundle metadata, and evidence export metadata. Evidence exports and support bundles use tenant-scoped access checks and short retention controls.

Wordwarden diagnostic and support output is redacted by default. Secrets, bind passwords, HMAC keys, bearer tokens, full LDAP filters, LDAP endpoint values, and raw passwords are excluded from support bundles and public-facing operational views.

## Migration Model

Directory Login can remain a permanent authentication method, or it can be used as a migration path toward Passkey-first authentication. Migration campaigns are explicit and do not start until a tenant admin enables and targets a campaign. Targeting can use tenant-wide rules, cohort rules, or user overrides.

Email Code fallback is controlled by tenant policy and campaign overrides. Authrim never converts Directory Login into an Authrim-managed password store.

## Operational Visibility

Wordwarden can report heartbeat inventory to Authrim with connector id, instance id, version, health, redacted configuration categories, and last seen time. Hostnames, LDAP endpoints, full error details, and directory-specific identifiers are excluded from heartbeat payloads.

Authrim shows managed connector status, recent status episodes, release advisories, evidence export status, support bundle status, and configuration history in the tenant admin surface.

## Release and Update Model

Wordwarden releases are distributed as signed tarballs and Docker images. Release artifacts include checksums, signature material, and SBOM output. Auto-update is not enabled by default; operators explicitly verify and apply updates.

## Incident and Support Boundary

Authrim can provide redacted support bundles and evidence exports for tenant admins with the required permissions. Detailed support bundles require explicit acknowledgement before creation. Operational alerts, support intake workflow, and external certification claims are handled outside this public summary.
