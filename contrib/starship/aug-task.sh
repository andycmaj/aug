#!/usr/bin/env bash
# The aug task a Claude Code session belongs to, for a starship [custom.aug_task]
# module in the claude-code statusline profile. Copy or symlink it to
#   ~/.config/starship/aug-task.sh
# Prints "AUG-0059 <title>[ · priority]", the task header's first line. Claude
# runs the statusline inside the agent's process, so an aug-launched agent has
# AUG_TASK_ID and AUG_HOME; a claude started by hand in a task window is found
# through the window's @aug_task tag. Anywhere else it prints nothing, which
# hides the module. An aug-tools too old to know `statusline` prints its usage
# and fails; that output is dropped, never shown in the status line.
set -uo pipefail

[ -n "${AUG_TASK_ID:-}${TMUX_PANE:-}" ] || exit 0
tools="${AUG_HOME:-$HOME/.aug}/bin/aug-tools"
[ -x "$tools" ] || exit 0
out=$("$tools" statusline 2>/dev/null) && printf '%s' "$out"
exit 0
