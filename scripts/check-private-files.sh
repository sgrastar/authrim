#!/usr/bin/env bash
# Check the Git index, not the filesystem: ignored local files are allowed.
set -euo pipefail

found=0
while IFS= read -r -d '' path; do
  case "/${path}/" in
    */private/*|*/AGENTS.md/|*/.authrim/*|*/.authrim_keys/*|*/.authrim-keys/*)
      found=1
      ;;
  esac
done < <(git ls-files -z)

if [ "$found" -ne 0 ]; then
  echo '::error::Internal files are tracked. Remove private/, AGENTS.md, .authrim/, .authrim_keys/ and .authrim-keys/ from the Git index; keep local copies.'
  exit 1
fi
