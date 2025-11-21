# Authrim UI

Frontend application for Authrim - OpenID Connect Provider on Cloudflare Workers.

## Tech Stack

- **Framework**: SvelteKit v5
- **CSS**: UnoCSS (Tailwind-compatible utilities)
- **Components**: Melt UI (headless, accessible)
- **Icons**: Lucide Svelte
- **i18n**: Paraglide (type-safe internationalization)
- **Deployment**: Cloudflare Pages

## Project Structure

```
packages/ui/
├── src/
│   ├── lib/
│   │   ├── components/       # Reusable Svelte components
│   │   │   ├── TestDialog.svelte
│   │   │   └── LanguageSwitcher.svelte
│   │   └── paraglide/        # Generated i18n code
│   ├── routes/               # SvelteKit routes
│   │   ├── +layout.svelte    # Root layout
│   │   └── +page.svelte      # Homepage
│   ├── app.css               # Global styles
│   └── app.html              # HTML template
├── messages/                 # i18n translation files
│   ├── en.json               # English
│   └── ja.json               # Japanese
├── static/                   # Static assets
├── project.inlang/           # Paraglide i18n config
├── uno.config.ts             # UnoCSS configuration
├── svelte.config.js          # SvelteKit configuration
└── vite.config.ts            # Vite configuration
```

## Development

### Prerequisites

- Node.js 18+
- pnpm 9+

### Install Dependencies

From the monorepo root:

```bash
pnpm install
```

### Environment Configuration

1. **Copy the environment template:**
   ```bash
   cd packages/ui
   cp .env.example .env
   ```

2. **Configure API endpoint** in `.env`:
   ```env
   # For local development (default)
   PUBLIC_API_BASE_URL=http://localhost:8786

   # For remote API (staging/production)
   # PUBLIC_API_BASE_URL=https://authrim.your-account.workers.dev
   ```

The UI needs to connect to the backend router. You can choose:
- **Local**: Connect to local router running on `http://localhost:8786`
- **Remote**: Connect to deployed router on Cloudflare Workers

### Start Development Server

```bash
cd packages/ui
pnpm run dev

# or from monorepo root
pnpm --filter=ui dev
```

The development server will start at `http://localhost:5173`.

**Important:** If using local API, make sure to start the backend router:
```bash
# In another terminal
cd packages/router
pnpm dev
```

### Available Scripts

| Script              | Description                          |
| ------------------- | ------------------------------------ |
| `dev`               | Start development server             |
| `build`             | Build for production                 |
| `preview`           | Preview production build             |
| `check`             | Run type checking                    |
| `lint`              | Run ESLint                           |
| `format`            | Format code with Prettier            |
| `typecheck`         | Type check without building          |
| `deploy:preview`    | Deploy preview to Cloudflare Pages   |
| `deploy:production` | Deploy production to Cloudflare Pages|

## Building

```bash
pnpm run build
```

Output will be in `.svelte-kit/cloudflare/`.

## Deployment

### Deploy to Cloudflare Pages

#### Option 1: CLI Deployment (Recommended for testing)

```bash
# Preview deployment
cd packages/ui
pnpm deploy:preview

# Production deployment
pnpm deploy:production
```

#### Option 2: GitHub Integration (Recommended for production)

1. **Connect repository** to Cloudflare Pages dashboard
2. **Configure build settings:**
   - Build command: `cd packages/ui && pnpm install && pnpm build`
   - Build output directory: `packages/ui/.svelte-kit/cloudflare`
   - Root directory: `/` (monorepo root)
   - Node version: 18

3. **Set environment variables** in Pages dashboard (Settings > Environment variables):

   **Production:**
   - Variable name: `PUBLIC_API_BASE_URL`
   - Value: `https://authrim.your-account.workers.dev` (your deployed router URL)

   **Preview (optional):**
   - Variable name: `PUBLIC_API_BASE_URL`
   - Value: `https://authrim-staging.your-account.workers.dev`

4. **Deploy** - Push to configured branch (e.g., `main`)

### Environment Variables

| Variable | Description | Local Default | Production Example |
|----------|-------------|---------------|-------------------|
| `PUBLIC_API_BASE_URL` | Backend API endpoint | `http://localhost:8786` | `https://authrim.workers.dev` |

**Note:** Environment variables prefixed with `PUBLIC_` are exposed to the browser. Never put secrets here.

### Switching Between Local and Remote API

Edit `.env` file to switch between environments:

```env
# Local development - connect to local router
PUBLIC_API_BASE_URL=http://localhost:8786

# Remote staging - connect to staging router
PUBLIC_API_BASE_URL=https://authrim-staging.workers.dev

# Remote production - connect to production router
PUBLIC_API_BASE_URL=https://auth.yourdomain.com
```

Restart the dev server (`pnpm dev`) after changing `.env`.

## Internationalization

This project uses Paraglide for type-safe i18n.

### Supported Languages

- English (`en`) - default
- Japanese (`ja`)

### Adding Translations

1. Edit `messages/en.json` and `messages/ja.json`
2. Use underscores for message keys (e.g., `app_title`)
3. Import and use in components:

```svelte
<script>
	import * as m from '$lib/paraglide/messages.js';
</script>

<h1>{m.app_title()}</h1>
```

### Changing Language

The `LanguageSwitcher` component allows users to switch languages. The selected language is persisted and triggers a page reload.

## Design System

### Colors

- **Primary**: Blue (#3B82F6) - Trust, security
- **Secondary**: Green (#10B981) - Success, authentication
- **Semantic**: Success, Warning, Error, Info

### Components

#### Buttons

```svelte
<button class="btn-primary">Primary</button>
<button class="btn-secondary">Secondary</button>
<button class="btn-ghost">Ghost</button>
```

#### Inputs

```svelte
<input class="input-base" type="text" />
<input class="input-error" type="text" />
```

#### Badges

```svelte
<span class="badge-success">Success</span>
<span class="badge-warning">Warning</span>
<span class="badge-error">Error</span>
<span class="badge-info">Info</span>
```

#### Card

```svelte
<div class="card">
	<!-- content -->
</div>
```

## Performance

### Bundle Size

- **CSS**: 3.10 KB (gzipped: 1.34 KB)
- **JS**: 47.29 KB (gzipped: 18.37 KB)

### Lighthouse Targets

- Performance: > 90
- Accessibility: > 95
- Best Practices: > 90
- SEO: > 90

## Contributing

1. Follow the existing code style (Prettier + ESLint)
2. Run `pnpm run format` before committing
3. Ensure `pnpm run check` passes
4. Add translations for new UI text

## License

Apache-2.0
