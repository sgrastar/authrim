---
project: Authrim
lang: en
date: 2026-07-23
description: 'Removed Consent Gate design.'
type: archive-note
tags:
  - authrim
  - flow
---

# Consent Gate design removed

The former shared Direct/OIDC/SAML Consent Gate design was removed before release. Authrim now
ships a separate `SAML SP/OIDC RP Flow` preset that performs no consent handling and branches only
between the SAML and OIDC completion paths.
