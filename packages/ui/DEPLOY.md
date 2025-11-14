# Cloudflare Pages Deployment Guide

This document describes how to deploy the Enrai UI to Cloudflare Pages.

## Prerequisites

- Cloudflare account with Pages access
- Git repository connected to Cloudflare Pages
- Node.js 18+ installed locally

## Build Configuration

### Cloudflare Pages Settings

Configure the following in the Cloudflare Pages dashboard:

| Setting                    | Value                                        |
| -------------------------- | -------------------------------------------- |
| **Build command**          | `pnpm install && pnpm run build --filter=ui` |
| **Build output directory** | `packages/ui/.svelte-kit/cloudflare`         |
| **Root directory**         | `/` (monorepo root)                          |
| **Environment variables**  | `NODE_VERSION=18`                            |

### Framework Preset

- **Framework**: SvelteKit
- **Adapter**: @sveltejs/adapter-cloudflare

## Manual Deployment

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build the UI Package

```bash
pnpm run build --filter=ui
```

### 3. Preview Locally

```bash
cd packages/ui
pnpm run preview
```

### 4. Deploy to Cloudflare Pages

The deployment is typically handled automatically via Git integration. When you push to the configured branch:

1. Cloudflare Pages detects the push
2. Runs the build command
3. Deploys the output directory

## Environment Variables

Currently, no environment variables are required for the UI package. As you add backend integration, you may need:

- `PUBLIC_API_URL` - Backend API URL
- `PUBLIC_TURNSTILE_SITE_KEY` - Cloudflare Turnstile site key (for captcha)

## Output Structure

The build outputs to `.svelte-kit/cloudflare/` with the following structure:

```
.svelte-kit/cloudflare/
├── _worker.js          # Cloudflare Pages Functions handler
├── _headers            # HTTP headers configuration
├── _routes.json        # Routes configuration
└── ...                 # Static assets
```

## Troubleshooting

### Build Fails with "Module not found"

Ensure you're running the build from the monorepo root:

```bash
cd /path/to/enrai
pnpm run build --filter=ui
```

### Deployment Shows Blank Page

Check that the output directory is set correctly to `packages/ui/.svelte-kit/cloudflare`.

### Preview Works but Production Doesn't

Ensure all environment variables are set in Cloudflare Pages dashboard under Settings > Environment variables.

## Custom Domain

To add a custom domain:

1. Go to Cloudflare Pages dashboard
2. Select your project
3. Navigate to "Custom domains"
4. Add your domain and follow DNS configuration instructions

## Performance Optimization

The build is optimized for Cloudflare Pages with:

- **Adapter**: @sveltejs/adapter-cloudflare
- **SSR**: Enabled (runs on Cloudflare Workers)
- **Code splitting**: Automatic
- **Asset optimization**: UnoCSS (3.10 KB gzipped)
- **Bundle size**: ~47 KB JS (gzipped: 18 KB)

## CI/CD Integration

Cloudflare Pages automatically deploys on:

- **Production branch** pushes (usually `main`)
- **Preview deployments** for pull requests

Configure branch settings in Cloudflare Pages dashboard.
