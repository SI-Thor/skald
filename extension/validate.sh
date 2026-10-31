#!/usr/bin/env bash
# Browserless extension validation: syntax + per-browser manifests + tests.
# (Bar render, highlight, real audio still need SMOKETEST.md in a browser.)
#
# Static (always):     node --check every JS file; build.sh; manifest rules
#                      for BOTH dists — Chrome's (no background.scripts —
#                      the addendum error — service_worker, offscreen files,
#                      min Chrome 116) and Firefox's (event page, gecko id,
#                      no Chrome-only keys); every manifest-referenced file
#                      exists in its dist.
# Unit (always):       node --test test/ — engine message choreography,
#                      stream fallback, voice-refusal recovery, payload shape.
# Live (if a daemon):  test/daemon-contract.mjs — the extension's voice/rate
#                      values against the real /v1/voices + synthesize.
set -euo pipefail
cd "$(dirname "$0")"
fail=0

# --- 1. syntax -------------------------------------------------------------------
for f in background.js offscreen.js lane.js content/loader.js src/*.js src/*/*.js options.js icons/generate.js test/*.mjs; do
  cp "$f" /tmp/skald_check.mjs 2>/dev/null || cp "$f" /tmp/skald_check.js
  if ! node --check /tmp/skald_check.mjs 2>/dev/null && ! node --check /tmp/skald_check.js 2>/dev/null; then
    echo "SYNTAX FAIL: $f"; fail=1
  fi
done

# --- 2. per-browser builds + manifest rules (ADR-0011) ----------------------------
./build.sh

python3 - <<'PY'
import json, os, sys

def check(dist, browser):
    bad = []
    def req(cond, label):
        if not cond:
            bad.append(label)
    m = json.load(open(f"{dist}/manifest.json"))

    # shared MV3 + referenced-file rules
    req(m["manifest_version"] == 3, f"{browser}: manifest_version 3")
    files = set()
    for k in ("16", "32", "48", "96"):
        files.add(m["icons"][k])
    files.add(m["options_ui"]["page"])
    bg = m.get("background", {})
    files |= set(bg.get("scripts", []))
    if "service_worker" in bg:
        files.add(bg["service_worker"])
    for war in m.get("web_accessible_resources", []):
        pass  # src/* wildcard, checked by directory below
    missing = [f for f in files if not os.path.exists(os.path.join(dist, f))]
    req(not missing, f"{browser}: referenced files exist (missing: {missing})")
    req(os.path.exists(f"{dist}/src/main.js"), f"{browser}: src/* present (web_accessible)")
    for p in ("http://localhost:8000/*",):
        req(p in m["host_permissions"], f"{browser}: host permission {p}")
    req(m.get("optional_host_permissions"), f"{browser}: optional_host_permissions for LAN grant")

    if browser == "chrome":
        req("scripts" not in bg, "chrome: NO background.scripts (Chrome error: 'requires manifest version of 2 or lower')")
        req(bg.get("service_worker") == "background.js", "chrome: background.service_worker")
        req("browser_specific_settings" not in m, "chrome: NO browser_specific_settings")
        req("offscreen" in m["permissions"], "chrome: offscreen permission (audio path, ADR-0011)")
        req(os.path.exists(f"{dist}/offscreen.html") and os.path.exists(f"{dist}/offscreen.js"),
            "chrome: offscreen files shipped")
        req(int(m.get("minimum_chrome_version", "0")) >= 116, "chrome: minimum_chrome_version >= 116 (offscreen + getContexts)")
    else:
        req(bg.get("scripts") == ["background.js"], "firefox: background.scripts event page")
        req("service_worker" not in bg, "firefox: NO service_worker (event page is the config)")
        gecko = m.get("browser_specific_settings", {}).get("gecko", {})
        req(gecko.get("id") == "skald@skald.local", "firefox: gecko id")
        req(gecko.get("strict_min_version", "0") >= "140", "firefox: strict_min_version >= 140")
        req("offscreen" not in m["permissions"], "firefox: NO offscreen permission (unknown to Firefox)")
        req("minimum_chrome_version" not in m, "firefox: NO minimum_chrome_version")
    return bad

problems = check("dist/chrome", "chrome") + check("dist/firefox", "firefox")
for p in problems:
    print(f"MANIFEST FAIL: {p}")
if problems:
    sys.exit(1)
print("MANIFEST-OK (dist/chrome + dist/firefox: MV3, per-browser background rules, referenced files exist)")
PY

# --- 3. unit/choreography tests ----------------------------------------------------
if ! node --test test/daemon-engine.test.mjs 2>&1 | tail -1 | grep -q "^ℹ"; then
  echo "TESTS FAIL"; fail=1
fi
if ! node --test test/daemon-engine.test.mjs 2>&1 | grep -q "fail 0"; then
  echo "TESTS FAIL (see above)"; fail=1
fi

# --- 4. live daemon contract (skip when no daemon) ---------------------------------
if curl -s --max-time 3 http://localhost:8000/v1/health >/dev/null 2>&1; then
  node test/daemon-contract.mjs http://localhost:8000 || fail=1
else
  echo "daemon-contract: SKIPPED (no daemon at localhost:8000)"
fi

[ $fail -eq 0 ] && echo VALIDATE-OK || exit 1
