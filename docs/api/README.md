# Authrim API Reference

This directory contains the Scalar entry point for Authrim API documentation.
The OpenAPI source of truth remains in package-local `openapi/` directories,
for example `packages/ar-management/openapi/admin.openapi.yaml`.

## Structure

- `specs.json`: Scalar navigation metadata and grouping.
- `index.html`: Generated API reference index, ignored by git.
- `scalar.html`: Generic Scalar viewer for a `?spec=` URL, ignored by git.
- `generated/*.html`: Generated Scalar pages for each OpenAPI document, ignored by git.
- `openapi/*.yaml`: Generated copies of package-local OpenAPI contracts, ignored by git.

After generation, the publishable API reference consists only of generated HTML
and generated OpenAPI copies. The product repository keeps the package-local
OpenAPI documents as the source of truth.

## Groups

- `Admin`: authenticated administrative APIs and admin-owned provisioning APIs.
- `Protocol and Public`: OIDC, OAuth, SAML, VC, discovery, and public auth flows.
- `User and Self-Service`: user-facing protected-resource and self-service APIs.
- `Operations`: runtime policy, authorization, and operational service APIs.

## Commands

```sh
pnpm docs:api
pnpm docs:api:serve
```

Then open `http://127.0.0.1:4173/docs/api/`.

Before regenerating docs after API changes, verify the OpenAPI contracts:

```sh
pnpm openapi:validate
pnpm openapi:routes -- --fail-on-missing
```

If a new package-level OpenAPI document is added, add an entry to `specs.json`
and run `pnpm docs:api`.
