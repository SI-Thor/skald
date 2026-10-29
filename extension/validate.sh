#!/usr/bin/env bash
# Browserless extension validation: syntax + manifest structure.
# (Browser behaviors — bar render, highlight, speech — still need SMOKETEST.md.)
set -euo pipefail
cd "$(dirname "$0")"
fail=0
for f in background.js lane.js content/loader.js src/*.js src/*/*.js options.js icons/generate.js; do
  cp "$f" /tmp/skald_check.mjs 2>/dev/null || cp "$f" /tmp/skald_check.js
  ext="${f##*.}"
  if [ "$ext" = "js" ]; then
    if ! node --check "/tmp/skald_check.mjs" 2>/dev/null && ! node --check /tmp/skald_check.js 2>/dev/null; then
      echo "SYNTAX FAIL: $f"; fail=1
    fi
  fi
done
python3 - <<'PY'
import json, os, sys
m = json.load(open("manifest.json"))
req_files = set()
for k in ("16","32","48","96"):
    req_files.add(m["icons"][k])
req_files |= set(m["background"].get("scripts", []))
if "service_worker" in m["background"]: req_files.add(m["background"]["service_worker"])
req_files.add(m["options_ui"]["page"])
missing = [f for f in req_files if not os.path.exists(f)]
assert not missing, f"missing files: {missing}"
assert m["manifest_version"] == 3 and m["browser_specific_settings"]["gecko"]["strict_min_version"] >= "140"
for port_perm in ("http://localhost:8000/*",):
    assert port_perm in m["host_permissions"]
print(f"MANIFEST-OK ({len(req_files)} referenced files exist, MV3, FF{m['browser_specific_settings']['gecko']['strict_min_version']}+)")
PY
[ $fail -eq 0 ] && echo VALIDATE-OK || exit 1
