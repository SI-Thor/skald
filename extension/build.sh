#!/usr/bin/env bash
# skald — per-browser extension builds from ONE source tree (ADR-0011).
#
# Why: Chrome rejects manifests that carry background.scripts (the owner's
# first Chrome load errored on exactly that), and Firefox does not know the
# 'offscreen' permission or background.service_worker. The source
# manifest.json is the canonical BOTH-browsers statement; this script writes
# the loadable per-browser manifests:
#
#   dist/chrome/   - background.service_worker, 'offscreen' permission,
#                    minimum_chrome_version 116 (offscreen + getContexts);
#                    NO background.scripts, NO browser_specific_settings
#   dist/firefox/  - background.scripts event page, gecko id, min FF 140;
#                    NO service_worker, NO 'offscreen' permission,
#                    NO minimum_chrome_version
#
# Installs ALWAYS point at a dist/ — never at the source tree. validate.sh
# re-runs this and checks both dists.
#
# Idempotent; run from anywhere:  extension/build.sh
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
for browser in chrome firefox; do
  mkdir -p "dist/$browser"
done

# Everything except the manifest (regenerated per browser below), the build
# machinery itself, the tests, and the docs. offscreen.* ship in both —
# Firefox simply never loads them.
for item in background.js offscreen.html offscreen.js \
            content icons lane.html lane.js lane.css \
            options.html options.js src; do
  cp -R "$item" "dist/chrome/$item"
  cp -R "$item" "dist/firefox/$item"
done

python3 - <<'PY'
import json

with open("manifest.json") as f:
    m = json.load(f)

# --- Chrome: service worker, no event page, no gecko block -------------------
chrome = json.loads(json.dumps(m))  # deep copy
bg = dict(chrome["background"])
bg.pop("scripts", None)  # THE addendum error: Chrome refuses this key
chrome["background"] = bg
chrome.pop("browser_specific_settings", None)  # unknown to Chrome
assert "service_worker" in chrome["background"], "source manifest must keep service_worker"
assert "offscreen" in chrome["permissions"], "Chrome audio path needs the offscreen permission"
with open("dist/chrome/manifest.json", "w") as f:
    json.dump(chrome, f, indent=2, ensure_ascii=False)
    f.write("\n")

# --- Firefox: event page, no service worker, no Chrome-only keys -------------
firefox = json.loads(json.dumps(m))
bg = dict(firefox["background"])
bg.pop("service_worker", None)  # Firefox warns; scripts is the real config
firefox["background"] = bg
firefox["permissions"] = [p for p in firefox["permissions"] if p != "offscreen"]
firefox.pop("minimum_chrome_version", None)
assert firefox["background"].get("scripts"), "source manifest must keep background.scripts"
assert firefox.get("browser_specific_settings", {}).get("gecko", {}).get("id"), "gecko id required"
with open("dist/firefox/manifest.json", "w") as f:
    json.dump(firefox, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

echo "built dist/chrome ($(find dist/chrome -type f | wc -l) files) and dist/firefox ($(find dist/firefox -type f | wc -l) files)"
