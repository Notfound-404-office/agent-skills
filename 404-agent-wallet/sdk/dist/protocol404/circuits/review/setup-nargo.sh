#!/bin/sh
# Install the checksum-pinned compiler locally; never modify the global PATH.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -sm)" != "Darwin arm64" ]; then
    printf '%s\n' 'This installer is pinned for Apple Silicon macOS. For other systems use Noirup with version 1.0.0-beta.25.' >&2
    exit 1
fi
mkdir -p "$here/.tools"
archive=$(mktemp "$here/.tools/nargo.XXXXXX")
trap 'rm -f "$archive"' EXIT
curl -fL --connect-timeout 10 --max-time 180 --output "$archive" 'https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.25/nargo-aarch64-apple-darwin.tar.gz'
python3 - "$archive" <<'PY'
import hashlib,sys
expected = '63ed453d09a65bfc78eef63252423126959d41c85de0da0cf54289c5e266ceb5'
with open(sys.argv[1], 'rb') as handle:
    actual = hashlib.sha256(handle.read()).hexdigest()
if actual != expected:
    sys.exit('Nargo archive SHA-256 mismatch; not extracting')
print('Official Nargo archive SHA-256 verified')
PY
tar -xzf "$archive" -C "$here/.tools"
"$here/.tools/nargo" --version
