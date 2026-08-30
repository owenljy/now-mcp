#!/usr/bin/env bash
#
# anti-pattern-scan.sh — single source of truth for the AI-agent anti-pattern scan.
#
# Invoked by sn-aia-agent-builder/SKILL.md (Step 7b). Do not paste these checks elsewhere —
# point at this script so the check list cannot drift.
#
# Checks (all "MUST be zero" hits are build/runtime blockers): [1] plain GlideRecord,
# [2] Rhino module syntax, [2b] manual IIFE eyeball, [3] Now.include dist/ path,
# [10] Now.include target resolution (target file must exist, be .js/.md, not under dist/),
# [4] .ts tool/agent scripts, [5] missing max_auto_executions, [6] marketing prose,
# [7] mixed placeholder styles, [8] setLimit(1) wrapper returns, [9] hard-fail action
# tools, [11] duplicate Now.ID names (deterministic sys_id collision),
# [12] 32-char hex literal in a server script (hardcoded sys_id — extends audit B11 to
# src/server; MUST be zero) + an INFORMATIONAL hardcoded-URL heuristic.
#
# Usage:
#   scripts/anti-pattern-scan.sh           # scans the whole repo (default '.')
#   scripts/anti-pattern-scan.sh <path>    # scope to a subtree
#
# Run from the repo root (the checks reference src/server and src/fluent relative
# to SCAN_ROOT). This is INFORMATIONAL — it prints findings but does not set a
# non-zero exit on blocker hits. Read the output and fix any hits on the
# "MUST be zero" checks before deploying.
#
# NOTE: uses `set -uo pipefail` but NOT `set -e` — `rg` exits non-zero when it
# finds zero matches, which is the SUCCESS case for several of these checks, so
# `-e` would abort a clean scan. `xargs -r` avoids running with no args.

set -uo pipefail

SCAN_ROOT="${1:-.}"

echo "=== Anti-pattern scan (root: $SCAN_ROOT) ==="

# Every rg-based check below treats "zero matches" as the success case, so a MISSING
# `rg` would make those checks print nothing and the whole scan exit 0 — a false all-clear.
# Abort loudly instead. (In an interactive host shell `rg` may be a shell function;
# in a plain bash/CI shell it must be a real ripgrep binary on PATH.)
if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep ('rg') is not on PATH. This scan relies on rg for nearly every check;" >&2
  echo "       without it the rg-based checks silently report zero hits (false all-clear)." >&2
  echo "       Install ripgrep (e.g. 'brew install ripgrep' / 'apt-get install ripgrep') and re-run." >&2
  exit 2
fi

echo
echo "--- [1] Plain GlideRecord in tool scripts (must use GlideRecordSecure) ---"
rg "new GlideRecord\(" --type ts --type js -l "$SCAN_ROOT"

echo
echo "--- [2] Module syntax in tool/agent scripts — Rhino has no module system, these all break at runtime. MUST be zero. ---"
echo "    (Scoped to the server script dirs to avoid matching fluent *.now.ts metadata.)"
rg -n "require\(|module\.exports|exports\.|^\s*import\s|^\s*export\s" "$SCAN_ROOT/src/server"

echo
echo "--- [2b] Manual eyeball: every tool/agent script must be wrapped in an IIFE ---"
echo "    The last top-level form must be \`})(...)\`, not a bare function declaration."
echo "    There is no automated form for this — open each tool-scripts/*.js and confirm"
echo "    it ends in an invoked IIFE that returns a value on every path."

echo
echo "--- [3] Now.include pointing at a compiled dist/ path — scripts must include their .js SOURCE directly. MUST be zero. ---"
rg -n "Now\.include\([^)]*\bdist/" "$SCAN_ROOT"

echo
echo "--- [10] Now.include targets that do not resolve to a real source file. MUST be zero. ---"
echo "    Each include path is resolved RELATIVE TO THE .now.ts FILE THAT CONTAINS IT (not the scan root)."
echo "    A target is reported UNRESOLVED if it is missing, is not a .js/.md source, or sits under dist/."
echo "    (Scoped to src/fluent real Fluent metadata; angle-bracket <placeholder> paths in templates/docs are skipped.)"
# rg --files on a missing dir prints nothing, so the loop is a no-op when src/fluent is absent.
while IFS= read -r ntfile; do
  [ -n "$ntfile" ] || continue
  ntdir="$(dirname "$ntfile")"
  # Extract the literal path argument of each Now.include('...') / Now.include("...") on this file,
  # then drop any unfilled <placeholder> path (templates/docs use ../<agent>/<tool-name>.js etc).
  while IFS= read -r inc; do
    [ -n "$inc" ] || continue
    target="$ntdir/$inc"
    # NOTE: use grep -E (ERE). BSD/macOS /usr/bin/grep does NOT treat BRE \| as alternation,
    # so a BRE pattern silently fails to match and produces false UNRESOLVED hits.
    if printf '%s\n' "$inc" | grep -qE "(^|/)dist/"; then
      echo "UNRESOLVED (points at dist/): $ntfile -> $inc"
    elif [ ! -f "$target" ]; then
      echo "UNRESOLVED (target missing): $ntfile -> $inc"
    elif ! printf '%s\n' "$inc" | grep -qE "\.(js|md)$"; then
      echo "UNRESOLVED (not a .js/.md source): $ntfile -> $inc"
    fi
  done < <(rg -oN "Now\.include\(\s*['\"]([^'\"]+)['\"]" -r '$1' "$ntfile" 2>/dev/null | grep -v '[<>]')
done < <(rg --files "$SCAN_ROOT/src/fluent" 2>/dev/null | rg "\.now\.ts$")

echo
echo "--- [4] Tool/agent script source authored as .ts (no tsc step exists for the Rhino runtime). Any .ts under tool-scripts/ or agent-scripts/ is a regression. MUST be zero. ---"
rg --files "$SCAN_ROOT/src/server" | rg "(tool-scripts|agent-scripts)/.*\.ts$"

echo
echo "--- [5] Missing max_auto_executions in M2M records ---"
rg "sn_aia_agent_tool_m2m" --files-with-matches "$SCAN_ROOT" | xargs -r rg -L "max_auto_executions"

echo
echo "--- [6] Marketing prose in agent role (wastes tokens, adds no signal) ---"
rg -i "friendly, helpful|empathetic|best possible experience|happy to assist" "$SCAN_ROOT"

echo
echo "--- [7] Mixed placeholder styles (pick <angle> and enforce) ---"
echo "    (Scoped to *.md docs/instructions; Fluent *.now.ts uses \$id and {{...}} queryCondition legitimately.)"
rg -o --type md "\\\$[A-Za-z_]+|\\{\\{[^}]+\\}\\}|\\{[A-Z_]+\\}" "$SCAN_ROOT"

echo
echo "--- [8] CRUD tools with setLimit(1) that still return a {count, records[]} wrapper ---"
echo "    (Pattern 2: single-row lookups return flat row, not wrapper — see docs/tool-output-patterns.md)"
for f in "$SCAN_ROOT"/src/server/agents/*/tool-scripts/*.js; do
  [ -e "$f" ] || continue
  if grep -q "setLimit(1)" "$f" && grep -q "records: records" "$f"; then
    echo "SINGLE-ROW LOOKUP RETURNING WRAPPER: $f (should return flat per Pattern 2)"
  fi
done

echo
echo "--- [9] State-mutating action tools that hard-fail instead of soft-fail ---"
echo "    (Pattern 4: missing context returns {success: true, note: '...'})"
rg -l "CASE_NOT_FOUND.*success.*false|NO_WRITE_PERMISSION.*success.*false" "$SCAN_ROOT"/src/server/agents/*/tool-scripts/*.js 2>/dev/null

echo
echo "--- [11] Duplicate Now.ID names — each name maps to ONE deterministic sys_id, so a repeat is a record collision. MUST be zero. ---"
echo "    (Scoped to src/fluent real Fluent metadata; angle-bracket <placeholder> names in templates/docs are skipped.)"
# Collect one "file<TAB>idname" line per Now.ID['name'] occurrence, skipping <placeholder> names.
nowid_pairs_file="$(mktemp)"
trap 'rm -f "$nowid_pairs_file"' EXIT
while IFS= read -r ntfile; do
  [ -n "$ntfile" ] || continue
  while IFS= read -r idname; do
    [ -n "$idname" ] || continue
    printf '%s\t%s\n' "$ntfile" "$idname" >> "$nowid_pairs_file"
  done < <(rg -oN "Now\.ID\[\s*['\"]([^'\"]+)['\"]\s*\]" -r '$1' "$ntfile" 2>/dev/null | grep -v '[<>]')
done < <(rg --files "$SCAN_ROOT/src/fluent" 2>/dev/null | rg "\.now\.ts$")
# Any idname (column 2) appearing more than once across files is a collision; list its files.
cut -f2 "$nowid_pairs_file" | sort | uniq -d | while IFS= read -r dn; do
  [ -n "$dn" ] || continue
  echo "DUPLICATE Now.ID '$dn' in:"
  awk -F'\t' -v n="$dn" '$2==n {print "    "$1}' "$nowid_pairs_file"
done

echo
echo "--- [12] 32-char hex literal in a server script (hardcoded sys_id — externalize per rule A4). MUST be zero. ---"
echo "    (Scans BOTH src/server/agents/*/tool-scripts/ and .../agent-scripts/ *.js; anchored \\b..\\b so it"
echo "     does not false-fire inside a longer git SHA / SHA-256. Add a trailing '// scan-allow-hex' comment"
echo "     to a line for the rare legit 32-char hex, e.g. a real MD5. This is a no-op if src/server is absent.)"
# rg -g globs; word-anchored to avoid matching 32-char windows inside 40/64-char hashes.
# NOTE the leading **/ — rg matches -g patterns against the FULL path, so a SCAN_ROOT-
# relative pattern without **/ never matches when SCAN_ROOT is an absolute/other dir.
# The `|| true` keeps a clean (zero-match) scan from tripping pipefail.
rg -n -g '**/src/server/agents/*/tool-scripts/*.js' -g '**/src/server/agents/*/agent-scripts/*.js' \
   '\b[0-9a-f]{32}\b' "$SCAN_ROOT" 2>/dev/null | grep -v 'scan-allow-hex' || true

echo
echo "--- [12b] INFORMATIONAL (heuristic, NOT MUST-be-zero): hardcoded http(s):// URL in a server script ---"
echo "    (Externalize endpoint URLs to a connection alias / system property per rule A4. Expect noise:"
echo "     also matches XML/SOAP namespace URIs like w3.org / xmlsoap.org — review, don't auto-fail.)"
rg -n -g '**/src/server/agents/*/tool-scripts/*.js' -g '**/src/server/agents/*/agent-scripts/*.js' \
   'https?://' "$SCAN_ROOT" 2>/dev/null || true

echo
echo "=== Scan complete. Hits on the \"MUST be zero\" checks are build/runtime blockers. ==="
