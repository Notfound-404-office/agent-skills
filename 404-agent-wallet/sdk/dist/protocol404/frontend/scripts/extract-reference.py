#!/usr/bin/env python3
"""Parse public data literals only; never execute the original browser bundle."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
FRONTEND = Path(__file__).resolve().parents[1]
ROOT = FRONTEND.parents[2]
sys.path.insert(0, str(ROOT / "re"))
from jslit import parse


def outputs():
    """Extract original deployment config and app ABIs without dependencies."""
    source = ROOT / "web-ref/pretty/index-CVtw0LZh.js"
    text = source.read_text()
    config_start = text.index("var WT = ") + len("var WT = ")
    yield "src/config/upstream-deployment.json", parse(text, config_start)
    abi_start = text.index("var dE = Object.fromEntries(") + len("var dE = Object.fromEntries(")
    names = {"PmToken", "PoseidonHasher", "PrivatePool", "ShieldBundle",
             "ShieldMarket", "ShieldMint", "TransferVerifier", "HoldVerifier"}
    for artifact in parse(text, abi_start):
        if artifact["contractName"] in names:
            yield f"src/abi/{artifact['contractName']}.ts", artifact["abi"]


if __name__ == "__main__":
    check = sys.argv[1:] == ["--check"]
    if sys.argv[1:] not in ([], ["--check"]):
        raise SystemExit("usage: extract-reference.py [--check]")
    for relative, data in outputs():
        path = FRONTEND / relative
        content = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        if path.suffix == ".ts":
            content = ("/** @orig index-CVtw0LZh.js:22495 dE Generated ABI; use scripts/extract-reference.py. */\n"
                       + "const abi = " + content.rstrip() + " as const;\nexport default abi;\n")
        if check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"reference mismatch: {relative}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        print(f"{'OK' if check else 'wrote'} {relative}")
