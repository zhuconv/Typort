#!/usr/bin/env bash
# Shell — a script with a function, a loop, and a guard.
set -euo pipefail

greet() {
  local name="${1:-world}"
  printf 'hello, %s\n' "$name"
}

main() {
  greet "Typort"

  for ext in md html ts py rs go; do
    echo "  sample available: example.${ext}"
  done

  if [[ -t 1 ]]; then
    echo "(stdout is a terminal)"
  fi
}

main "$@"
