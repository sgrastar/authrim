# Login UI Storybook deployment

The Login UI Storybook is published at
[login.storybook.authrim.com](https://login.storybook.authrim.com/?path=/docs/introduction--docs).

`.github/workflows/deploy-login-storybook.yml` builds the repository's `develop`
commit after every push, including merged pull requests, and publishes only
`packages/ar-login-ui/storybook-static` through Cloudflare Workers Static
Assets. Pull request branches do not deploy to the public domain. Deployments
are serialized to avoid overlapping uploads. A failed build keeps the previous
deployment in place. It is deployed the same way as the
[Admin Storybook](admin-storybook-deployment.md), as its own Worker.

## Prerequisites

- Merge `packages/ar-login-ui`, its Storybook source, and corresponding
  workspace lockfile changes into `develop` before the first automated build.
- The `authrim.com` zone must be active in the target Cloudflare account.
- Repository secret `CLOUDFLARE_ACCOUNT_ID` identifies that account.
- Repository secret `CLOUDFLARE_API_TOKEN` needs permission to deploy Workers
  and configure the custom domain in that account and zone. Credentials are
  passed only to the publish step.

`login-storybook.cloudflare.jsonc` is the dedicated, non-secret deployment
config (Worker `authrim-login-storybook`). Wrangler manages the custom domain's
DNS and certificate. This deployment has no API Worker, database bindings, or
login backend: the stories render the Login UI with fixtures only.

## Local build and deployment

From a clean checkout of the intended `develop` commit:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter '@authrim/ar-login-ui^...'
pnpm --filter @authrim/ar-login-ui run build-storybook
pnpm exec wrangler deploy --config login-storybook.cloudflare.jsonc --dry-run
pnpm exec wrangler deploy --config login-storybook.cloudflare.jsonc
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
