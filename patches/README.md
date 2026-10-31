# Dependency patches

## extract-zip 2.0.1

The Zod 4 migration removes this dependency from the Lighthouse CI tree by updating
Puppeteer Core. Its local patch and advisory exceptions are no longer needed.

The retired patch rejected symlink targets outside the extraction directory and created regular
files exclusively (`wx`). This prevented archive entries from overwriting files through
an existing final-component symlink, including links planted by an earlier archive entry.
Ordinary extraction and in-directory symlinks remained supported. Existing destination files
and duplicate file entries were deliberately rejected instead of overwritten.

`pnpm security:audit` retains `scripts/check-extract-zip-patch.mjs` before invoking the audit.
The check validates the lockfile and confirms that extract-zip is absent. If it reappears,
the original extraction regressions run and fail against unpatched 2.0.1. An explicit
module path can still be passed to the script to check an archived implementation.
