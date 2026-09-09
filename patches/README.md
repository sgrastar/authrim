# Dependency patches

## extract-zip 2.0.1

The Lighthouse CI dependency tree still installs this version. The npm registry has no
published 2.0.2 release, despite the audit feed naming that version as patched.

The patch rejects symlink targets outside the extraction directory and creates regular
files exclusively (`wx`). This prevents archive entries from overwriting files through
an existing final-component symlink, including links planted by an earlier archive entry.
Ordinary extraction and in-directory symlinks remain supported. Existing destination files
and duplicate file entries are deliberately rejected instead of overwritten.

`pnpm security:audit` runs `scripts/check-extract-zip-patch.mjs` before invoking the audit.
The regression check fails against unpatched 2.0.1. The two upstream advisory exceptions
in `pnpm-workspace.yaml` apply to this locally patched dependency; they do not replace the
regression check. Remove the patch and exceptions when the dependency tree can use a
published upstream fix, and retain the regression check during that update.
