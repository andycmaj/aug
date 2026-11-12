#!/usr/bin/env bash
# revdiff's launcher, user layer: `aug install revdiff` writes this to
#   ~/.claude/plugins/data/revdiff-<marketplace>/scripts/launch-revdiff.sh
# It runs the installed plugin's own launcher with one backend added ahead of
# its tmux ones. Inside an aug task window (the window carries @aug_tools) the
# review opens in a zoomed split of claude's own window through `aug-tools pane`,
# so it shows in aug's viewer and outlives a detached client, instead of in a
# new window (REVDIFF_TMUX_WINDOW=1) or a popup on whichever client tmux picks.
# The rest of the launcher is read from the plugin each time, so a plugin update
# never leaves a stale copy here; anywhere but aug it is the plugin's, untouched.
set -euo pipefail

plugins="$HOME/.claude/plugins"
root=$(jq -r '.plugins["revdiff@revdiff"][0].installPath // empty' "$plugins/installed_plugins.json" 2>/dev/null || true)
[ -n "$root" ] || root=$(ls -d "$plugins"/cache/revdiff/revdiff/*/ 2>/dev/null | sort -V | tail -1)
bundled="${root%/}/.claude-plugin/skills/revdiff/scripts/launch-revdiff.sh"
if [ ! -f "$bundled" ]; then
    echo "error: revdiff plugin launcher not found under $plugins" >&2
    exit 1
fi

tools=""
if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
    tools=$(tmux display-message -p -t "$TMUX_PANE" '#{@aug_tools}' 2>/dev/null || true)
fi
[ -n "$tools" ] || exec bash "$bundled" "$@"

# Spliced in where the plugin starts its tmux backends: by then it has built
# REVDIFF_CMD (output file, stdin spool, stderr capture, editor env) and CWD.
# $tools is already shell-quoted, so it goes through eval as words.
backend=$(cat <<'AUG'
if [ -n "${AUG_TOOLS:-}" ]; then
    rc=0
    eval "$AUG_TOOLS pane --zoom --wait --cwd $(sq "$CWD") -- sh -c $(sq "$REVDIFF_CMD")" || rc=$?
    print_output_and_exit "$rc"
fi

AUG
)
marker='^# agent-deck: '
grep -q "$marker" "$bundled" || exec bash "$bundled" "$@"
# Through the environment: BSD awk refuses a newline in a -v value.
script=$(BACKEND="$backend" awk -v marker="$marker" '$0 ~ marker && !done { print ENVIRON["BACKEND"]; done = 1 } { print }' "$bundled")
AUG_TOOLS="$tools" exec bash -c "$script" "$bundled" "$@"
