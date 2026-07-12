# Authrim Management OpenAPI

This directory contains OpenAPI contracts owned by `@authrim/ar-management`.

- `admin.openapi.yaml`: authenticated Admin API under `/api/admin/*`.
- `frontend-auth.openapi.yaml`: Login UI discovery and grant bootstrap endpoints under `/api/auth/*`.
- `oauth-management.openapi.yaml`: dynamic client registration, introspection, revocation, and
  self-service device endpoints.
- `scim.openapi.yaml`: SCIM 2.0 provisioning endpoints under `/scim/v2/*`.
- `user-self-service.openapi.yaml`: user consent and data export endpoints under `/api/user/*`.

These files are intended for security testing, contract review, documentation,
and future client/tool generation. Keep them free of secrets and environment
specific credentials.

When an `ar-management` route is added, removed, renamed, or has request or
response semantics changed, update the relevant OpenAPI file in the same change.
Run `pnpm openapi:validate` for schema checks and
`pnpm openapi:routes -- --fail-on-missing` to compare implemented public routes
with documented routes. Operations marked with
`x-authrim-route-coverage: inferred-from-source` are coverage stubs; replace
them with detailed request, response, and error schemas as the API is changed.
