# Admin Storybook deployment

The Admin Console Storybook is published at
[admin.storybook.authrim.com](https://admin.storybook.authrim.com/?path=/docs/introduction--docs).

`.github/workflows/deploy-admin-storybook.yml` builds the repository's `develop`
commit after every push, including merged pull requests, and publishes only
`packages/ar-admin-console/storybook-static` through Cloudflare Workers Static
Assets. Pull request branches do not deploy to the public domain. Deployments
are serialized to avoid overlapping uploads. A failed build keeps the previous
deployment in place.

## Prerequisites

- Merge `packages/ar-admin-console`, its Storybook source, and corresponding
  workspace lockfile changes into `develop` before the first automated build.
- The `authrim.com` zone must be active in the target Cloudflare account.
- Repository secret `CLOUDFLARE_ACCOUNT_ID` identifies that account.
- Repository secret `CLOUDFLARE_API_TOKEN` needs permission to deploy Workers
  and configure the custom domain in that account and zone. Credentials are
  passed only to the publish step.

`storybook.cloudflare.jsonc` is the dedicated, non-secret deployment config.
Wrangler manages the custom domain's DNS and certificate. This deployment has
no API Worker, database bindings, or Admin Console login backend.

## Local build and deployment

From a clean checkout of the intended `develop` commit:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter '@authrim/ar-admin-console^...'
pnpm --filter @authrim/ar-admin-console run build-storybook
pnpm exec wrangler deploy --config storybook.cloudflare.jsonc --dry-run
pnpm exec wrangler deploy --config storybook.cloudflare.jsonc
```

Authenticate Wrangler locally or supply the Cloudflare credentials through
environment variables. Do not commit generated Storybook output or credentials.

Once the workflow also exists on the repository's default branch, it can be
rerun manually with `develop` selected as the branch. Otherwise push a new
commit to `develop` to trigger a deployment. Public checks verify the manager,
preview iframe, and Introduction entry in `index.json`. DNS and certificate
provisioning is retried for up to ten minutes per endpoint. HTML redirects are
followed, and the root URL serves the Storybook manager. Rerun verification after
provisioning completes if necessary.
