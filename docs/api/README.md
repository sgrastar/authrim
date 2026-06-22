# Authrim API Reference

This directory contains the publishable OpenAPI copies used by the Authrim
website. The OpenAPI source of truth remains in package-local `openapi/`
directories, for example `packages/ar-management/openapi/admin.openapi.yaml`.

## Structure

- `specs.json`: OpenAPI source metadata and grouping.
- `openapi/*.yaml`: Generated copies of package-local OpenAPI contracts, ignored by git.
- `openapi/*.json`: Generated JSON copies for website tooling, ignored by git.

The product repository does not publish static API reference HTML. The website
repository renders these OpenAPI copies through Starlight OpenAPI.

## Groups

- `Admin`: authenticated administrative APIs and admin-owned provisioning APIs.
- `Protocol and Public`: OIDC, OAuth, SAML, VC, discovery, and public auth flows.
- `User and Self-Service`: user-facing protected-resource and self-service APIs.
- `Operations`: runtime policy, authorization, and operational service APIs.

## Commands

```sh
pnpm docs:api
```

Before regenerating docs after API changes, verify the OpenAPI contracts:

```sh
pnpm openapi:validate
pnpm openapi:routes -- --fail-on-missing
```

If a new package-level OpenAPI document is added, add an entry to `specs.json`
and run `pnpm docs:api`.
