#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null; then
  echo "Need Node 22.13+ on PATH." >&2
  exit 1
fi

npm install
npm test
npm run check

echo "== tokens =="
"$ROOT/bin/crx-re.mjs" tokens

OUT="$ROOT/out/hello-world"
echo "== analyze hello-world -> $OUT =="
"$ROOT/bin/crx-re.mjs" analyze "$ROOT/fixtures/hello-world" --out "$OUT"

echo
echo "Local smoke passed."
echo "Inventory: $OUT/inventory.json"
echo "Architecture: $OUT/architecture.json"
echo "Report: $OUT/REPORT.md"
echo
echo "Store listing (optional, network):"
echo "  $ROOT/bin/crx-re.mjs analyze https://chromewebstore.google.com/detail/chrome-extension-source-viewer/jifpbeccnghkjeaalbbjmodiffmgedin --out $ROOT/out/crx-viewer"
