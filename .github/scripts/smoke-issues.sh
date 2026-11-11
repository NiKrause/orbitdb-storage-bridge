#!/usr/bin/env bash
# One issue per provider for the daily smoke test: opened (or commented on)
# on each failing day, closed with a comment once it passes again.
#
# Usage: smoke-issues.sh <provider> <job result> <report dir>
#   job result: success | failure | cancelled | skipped
# Needs GH_TOKEN (the workflow's GITHUB_TOKEN with issues: write), GITHUB_REPOSITORY,
# RUN_URL.
set -euo pipefail
provider="$1"; result="$2"; dir="${3:-}"
label="live-smoke"
title="Live smoke test: ${provider} failing"

gh label create "$label" --color B60205 \
  --description "Opened and closed by the daily live smoke test" >/dev/null 2>&1 || true

number="$(gh issue list --label "$label" --state open --search "\"${title}\" in:title" \
  --json number,title --jq "map(select(.title == \"${title}\")) | .[0].number // empty")"

case "$result" in
  failure)
    body_file="$(mktemp)"
    {
      echo "The daily live smoke test failed for **${provider}** on $(date -u +%F): ${RUN_URL}"
      echo
      if [ -n "$dir" ] && [ -f "$dir/report.md" ]; then cat "$dir/report.md"
      else echo "_No test report: the job failed before the suites ran (key check, install, or setup). See the run._"
      fi
    } >"$body_file"
    if [ -n "$number" ]; then
      gh issue comment "$number" --body-file "$body_file"
    else
      gh issue create --title "$title" --label "$label" --body-file "$body_file"
    fi
    ;;
  success)
    if [ -n "$number" ]; then
      gh issue close "$number" --comment "Passing again on $(date -u +%F): ${RUN_URL}"
    fi
    ;;
  *)
    echo "${provider}: ${result}, no issue change"
    ;;
esac
