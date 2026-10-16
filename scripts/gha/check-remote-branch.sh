#!/usr/bin/env bash
# check-remote-branch.sh
# ─────────────────────────────────────────────────────────────────────
# Fail-closed remote branch existence check for GitHub Actions sampling
# workflows.
#
# Distinguishes three outcomes from `git ls-remote --heads <remote> <branch>`:
#   1. Command succeeded AND stdout contains the branch → "present"
#   2. Command succeeded AND stdout does not contain the branch → "absent"
#      (genuine first-run case; the branch does not exist on the remote)
#   3. Command FAILED (network, auth, git error) → "error"
#      This MUST NOT enter the first-run creation path.
#
# The previous workflow YAML used `git ls-remote ... 2>/dev/null | grep -q`
# combined with a negated pipeline, which collapsed cases (2) and (3) into
# a single "branch absent" path — meaning a transient network failure or
# auth error would silently trigger the orphan-branch creation path and
# potentially clobber existing remote data.
#
# Usage:
#   source scripts/gha/check-remote-branch.sh
#   check_remote_branch <remote_url_or_alias> <branch_name>
#
# Outputs (to stdout, single line):
#   present | absent | error
#
# Exit codes:
#   0  — successfully determined state (present or absent)
#   1  — git ls-remote failed (network/auth/git error)
#
# The caller is expected to fail-closed on exit code 1.
# ─────────────────────────────────────────────────────────────────────
check_remote_branch() {
  local remote="$1"
  local branch="$2"

  if [ -z "$remote" ] || [ -z "$branch" ]; then
    echo "error" >&2
    echo "check_remote_branch: remote and branch are required" >&2
    return 1
  fi

  # Capture stdout AND stderr separately, preserve exit status.
  # Do NOT use `2>/dev/null` — that hides the failure mode entirely.
  local ls_stdout ls_stderr ls_exit
  ls_stdout=$(git ls-remote --heads "$remote" "$branch" 2>/tmp/ls-stderr-$$)
  ls_exit=$?
  ls_stderr=$(cat /tmp/ls-stderr-$$ 2>/dev/null)
  rm -f /tmp/ls-stderr-$$

  if [ "$ls_exit" -ne 0 ]; then
    echo "error" >&2
    echo "check_remote_branch: git ls-remote failed (exit $ls_exit)" >&2
    echo "  remote: $remote" >&2
    echo "  branch: $branch" >&2
    if [ -n "$ls_stderr" ]; then
      echo "  stderr: $ls_stderr" >&2
    fi
    return 1
  fi

  # Success — now check whether the branch was matched.
  # `git ls-remote --heads origin <branch>` prints a line like:
  #   <sha>\trefs/heads/<branch>
  # when the branch exists, and prints nothing when it does not.
  if [ -n "$ls_stdout" ] && echo "$ls_stdout" | grep -q "refs/heads/${branch}\$"; then
    echo "present"
    return 0
  fi

  echo "absent"
  return 0
}

# Allow direct invocation: `./check-remote-branch.sh <remote> <branch>`
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  check_remote_branch "$@"
fi
