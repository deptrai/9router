#!/usr/bin/env bash
# AC9 — Protobuf sync script.
# Copies windsurfProtobuf.js + windsurfAuth.js from parent open-sse/utils/,
# auto-converts ESM→CJS:
#   (a) export function → function + append module.exports
#   (b) import {x} from "y" → const {x} = require("y")
# Run before every release to prevent drift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_DIR="$PROJECT_ROOT/open-sse/utils"
DST_DIR="$PROJECT_ROOT/mitm-client/src/utils"

FILES=("windsurfProtobuf.js" "windsurfAuth.js")

echo "=== Protobuf Sync Script ==="
echo "Source: $SRC_DIR"
echo "Target: $DST_DIR"
echo ""

# Verify source directory exists.
if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: Source directory not found: $SRC_DIR"
  exit 1
fi

# Ensure target directory exists.
mkdir -p "$DST_DIR"

for file in "${FILES[@]}"; do
  src="$SRC_DIR/$file"
  dst="$DST_DIR/$file"

  if [ ! -f "$src" ]; then
    echo "WARN: Source file not found: $src — skipping."
    continue
  fi

  echo "Processing: $file"

  # Copy source file.
  cp "$src" "$dst"

  # ── ESM → CJS conversion ──

  # (b) Convert import statements: import {x} from "y" → const {x} = require("y")
  #     Also handle: import x from "y" → const x = require("y")
  #     And: import * as x from "y" → const x = require("y")
  #     And: import "y" → require("y")
  # Use perl for multiline-safe in-place editing.
  perl -i -pe '
    # import { a, b } from "path" → const { a, b } = require("path")
    s/^import\s*\{([^}]+)\}\s*from\s*["\x27]([^"\x27]+)["\x27]\s*;?\s*$/const {$1} = require("$2");/;
    # import defaultExport from "path" → const defaultExport = require("path")
    s/^import\s+(\w+)\s+from\s*["\x27]([^"\x27]+)["\x27]\s*;?\s*$/const $1 = require("$2");/;
    # import * as name from "path" → const name = require("path")
    s/^import\s+\*\s+as\s+(\w+)\s+from\s*["\x27]([^"\x27]+)["\x27]\s*;?\s*$/const $1 = require("$2");/;
    # import "path" → require("path")
    s/^import\s*["\x27]([^"\x27]+)["\x27]\s*;?\s*$/require("$1");/;
  ' "$dst"

  # (a) Convert export function → function, and collect exported names.
  # Also handle: export { a, b, c } → module.exports = { a, b, c }
  # And: export const/let → const/let (add to module.exports)

  # Track exported function/const names.
  exported_names=""

  # Convert "export function foo(" → "function foo(" and collect name.
  # Use perl to extract function names.
  while IFS= read -r funcname; do
    if [ -n "$funcname" ]; then
      exported_names="${exported_names}${funcname} "
    fi
  done < <(perl -ne 'print "$1\n" if /^export\s+function\s+(\w+)/' "$dst")

  # Convert "export const foo" → "const foo" and collect name.
  while IFS= read -r constname; do
    if [ -n "$constname" ]; then
      exported_names="${exported_names}${constname} "
    fi
  done < <(perl -ne 'print "$1\n" if /^export\s+(?:const|let)\s+(\w+)/' "$dst")

  # Remove "export " prefix from function/const declarations.
  perl -i -pe 's/^export\s+(function\s)/$1/; s/^export\s+(const\s)/$1/; s/^export\s+(let\s)/$1/' "$dst"

  # Handle "export { a, b, c };" — extract names and remove line.
  export_block_names=$(perl -ne 'print "$1 " if /^export\s*\{([^}]+)\}\s*;?\s*$/ && print STDERR "EXPORT_BLOCK:$1\n"' "$dst" 2>&1)
  # Remove export { ... } lines.
  perl -i -ne 'print unless /^export\s*\{[^}]+\}\s*;?\s*$/' "$dst"

  # Handle "export default" — convert to module.exports = .
  # (rare in these files, but handle for safety)
  perl -i -pe 's/^export\s+default\s+/module.exports = /' "$dst"

  # Build module.exports appendix.
  # Trim and deduplicate exported names.
  export_str=""
  if [ -n "$exported_names" ]; then
    # Create module.exports with all exported names.
    names_trimmed=$(echo "$exported_names" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/ $//')
    if [ -n "$names_trimmed" ]; then
      export_str=$(echo "$names_trimmed" | sed 's/ /, /g')
      echo "" >> "$dst"
      echo "// Auto-generated module.exports (ESM→CJS conversion)" >> "$dst"
      echo "module.exports = { $export_str };" >> "$dst"
    fi
  fi

  echo "  ✅ Converted: $file → $(basename "$dst")"
  if [ -n "$export_str" ]; then
    echo "     Exported: $export_str"
  fi
  echo ""
done

# Verify output files are valid CJS (can be required).
echo "=== Verification ==="
for file in "${FILES[@]}"; do
  dst="$DST_DIR/$file"
  if [ -f "$dst" ]; then
    if node -e "require('$dst')" 2>/dev/null; then
      echo "  ✅ $file — valid CJS (require() succeeded)"
    else
      echo "  ⚠️  $file — require() failed (may have runtime deps, check manually)"
    fi
  fi
done

echo ""
echo "=== Sync complete ==="
echo "Run this script before every release to prevent drift."
