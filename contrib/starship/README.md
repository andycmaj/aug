# starship: the aug task in Claude Code's status line

`aug-tools statusline` prints the task a Claude Code session belongs to
(`AUG-0059 <title>`, plus the priority when it is not regular), or nothing
outside aug. `aug-task.sh` wraps it for a starship custom module.

1. Copy or symlink `aug-task.sh` to `~/.config/starship/aug-task.sh`.
2. Add the module and put it in the profile Claude Code's `statusLine` runs
   (`starship statusline claude-code`):

```toml
[custom.aug_task]
command = "~/.config/starship/aug-task.sh"
when = true
format = "([$output]($style)[ │ ](fg:244))"
style = "bold fg:178"
shell = ["bash", "--noprofile", "--norc"]
description = "aug task this Claude session works"

[profiles]
claude-code = "${custom.aug_task}$claude_model$claude_context$claude_cost"
```

`when = true` runs the helper on every redraw; it returns at once when neither
`AUG_TASK_ID` nor `TMUX_PANE` is set. The parentheses in `format` make the
whole module, divider included, vanish when the helper prints nothing;
starship would draw a bare `│` otherwise. No aug setting is needed: aug-launched agents already carry
`AUG_TASK_ID`, and Claude Code passes its env to the status line command.
