# Enrai UI

Frontend application for Enrai - OpenID Connect Provider on Cloudflare Workers.

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

### Start Development Server

```bash
cd packages/ui
pnpm run dev

# or from monorepo root
pnpm --filter=ui dev
```

The development server will start at `http://localhost:5173`.

### Available Scripts

| Script      | Description                 |
| ----------- | --------------------------- |
| `dev`       | Start development server    |
| `build`     | Build for production        |
| `preview`   | Preview production build    |
| `check`     | Run type checking           |
| `lint`      | Run ESLint                  |
| `format`    | Format code with Prettier   |
| `typecheck` | Type check without building |

## Building

```bash
pnpm run build
```

Output will be in `.svelte-kit/cloudflare/`.

## Deployment

See [DEPLOY.md](./DEPLOY.md) for detailed deployment instructions to Cloudflare Pages.

### Quick Deploy

Cloudflare Pages automatically deploys when you push to the configured branch.

**Build settings:**

- Build command: `pnpm install && pnpm run build --filter=ui`
- Build output directory: `packages/ui/.svelte-kit/cloudflare`
- Node version: 18

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
