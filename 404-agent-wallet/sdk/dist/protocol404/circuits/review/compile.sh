#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$here/.tools/nargo" ]; then
    circuit_nargo="$here/.tools/nargo"
else
    circuit_nargo=$(command -v nargo || true)
fi
if [ -z "$circuit_nargo" ]; then
    printf '%s\n' 'Nargo is missing. Run sh setup-nargo.sh in a network-enabled terminal first.' >&2
    exit 1
fi
version=$("$circuit_nargo" --version)
printf '%s\n' "$version"
if ! printf '%s\n' "$version" | grep -Eq '(^|[[:space:]])1\.0\.0-beta\.25([+[:space:]]|$)'; then
    printf '%s\n' 'Refusing a compiler other than 1.0.0-beta.25.' >&2
    exit 1
fi
cd "$here"
"$circuit_nargo" compile --workspace
python3 "$here/compare-build.py"
