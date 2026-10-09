#!/usr/bin/env bash
# Claude Code and Codex hook. File-edit tools record the repo files each agent changes; that agent's stop formats and lints them.
#   after-tool  PostToolUse on file edits
#   turn-start  UserPromptSubmit: drops queued files changed since the agent last edited them, as after an interrupted turn
#   check       Stop and SubagentStop: blocks the stop while formatting or lint fails
set -euo pipefail

if ! command -v jq >/dev/null; then
	if [[ ${1:-} == check ]]; then
		echo '{"systemMessage": "agent-lint-hook skipped: install jq to format and lint the files changed by the agent."}'
	fi
	exit 0
fi

max_blocks=3
input=$(cat)
session=$(jq -j '.session_id // "default"' <<<"$input" | tr -c 'A-Za-z0-9_-' '_')
# Subagents run alongside their parent, so an agent must only ever format the files it changed itself.
agent=$(jq -j '.agent_id | select(. != "") // "main"' <<<"$input" | tr -c 'A-Za-z0-9_-' '_')
cd "$(dirname "$0")/.."
root=$(pwd -P)
# Queued paths are relative to this checkout, and one session can span several checkouts.
state_dir="${TMPDIR:-/tmp}/agent-lint-hook/$(printf %s "$root" | git hash-object --stdin)"
files="$state_dir/$session.$agent.files"
blocks="$state_dir/$session.$agent.blocks"
mkdir -p "$state_dir"

record_path() {
	local path=$1 dir
	[[ $path == /* ]] || path="$cwd/$path"
	dir=${path%/*}
	dir=$(cd -P -- "${dir:-/}" 2>/dev/null && pwd) || return 0
	path=${dir%/}/${path##*/}
	[[ $path == "$root"/* ]] || return 0
	path=${path#"$root"/}
	case /$path/ in */../*) return 0 ;; esac
	git check-ignore -q -- "$path" || printf '%s\0' "$path" >>"$files"
}

case "${1:-}" in
after-tool)
	cwd=$(jq -r --arg root "$root" '.cwd // $root' <<<"$input")
	case $(jq -r '.tool_name' <<<"$input") in
	apply_patch)
		while IFS= read -r path; do
			record_path "$path"
		done < <(jq -r '.tool_input.command // ""' <<<"$input" | sed -n -E 's/^\*\*\* (Add File|Update File|Move to): //p')
		;;
	*)
		path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input")
		[[ -z $path ]] || record_path "$path"
		;;
	esac
	exit 0
	;;
turn-start)
	[[ -s $files ]] || exit 0
	# The queue's mtime is the agent's last recorded edit; a queued file newer than that was changed by someone else.
	kept=()
	while IFS= read -r -d '' file; do
		[[ $file -nt $files ]] || kept+=("$file")
	done < <(sort -zu "$files")
	if ((${#kept[@]})); then
		printf '%s\0' "${kept[@]}" >"$files"
	else
		rm -f "$files"
	fi
	exit 0
	;;
check) ;;
*)
	echo "usage: $0 after-tool|turn-start|check" >&2
	exit 64
	;;
esac

[[ $(jq -r '.stop_hook_active // false' <<<"$input") == true ]] || rm -f "$blocks"
[[ -s $files ]] || exit 0

if ! command -v bun >/dev/null || [[ ! -e node_modules/.bin/oxfmt || ! -e node_modules/.bin/oxlint || ! -e node_modules/.bin/eslint ]]; then
	rm -f "$files"
	echo '{"systemMessage": "agent-lint-hook skipped: run `bun install` to format and lint the files changed by the agent."}'
	exit 0
fi

changed=()
lintable=()
while IFS= read -r -d '' file; do
	[[ -f $file && ! -L $file ]] || continue
	changed+=("$file")
	case $file in
	*.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) lintable+=("$file") ;;
	esac
done < <(sort -zu "$files")
if ((!${#changed[@]})); then
	rm -f "$files"
	exit 0
fi

problems=()
out=$(bun x oxfmt --no-error-on-unmatched-pattern "${changed[@]}" 2>&1) || problems+=("$out")
if ((${#lintable[@]})); then
	out=$(bun x oxlint --deny-warnings --no-error-on-unmatched-pattern "${lintable[@]}" 2>&1) || problems+=("$out")
	out=$(bun x eslint --max-warnings 0 --no-warn-ignored "${lintable[@]}" 2>&1) || problems+=("$out")
fi
if ((!${#problems[@]})); then
	rm -f "$files" "$blocks"
	exit 0
fi

count=$(($(cat "$blocks" 2>/dev/null || echo 0) + 1))
if ((count > max_blocks)); then
	rm -f "$files" "$blocks"
	jq -n --arg msg "Formatting or lint still fails after $max_blocks fix attempts; stopping anyway." '{systemMessage: $msg}'
	exit 0
fi
echo "$count" >"$blocks"
# oxfmt's rewrites above are the agent's, so they must not look newer than the queue to turn-start.
touch "$files"
reason=$(printf '%s\n\n' 'Formatting or lint failed on files changed by the agent. Fix every problem below, then finish.' "${problems[@]}" | sed -n '1,200p')
jq -n --arg reason "$reason" '{decision: "block", reason: $reason}'
