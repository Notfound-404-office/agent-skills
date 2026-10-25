#!/usr/bin/env python3
"""Offline integrity and interface checks for the exported circuit reading pack."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def field_count(kind):
    return kind["length"] * field_count(kind["type"]) if kind["kind"] == "array" else 1


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    for relative, expected in manifest["files"].items():
        actual = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError("SHA-256 mismatch: " + relative)
    subprocess.run([sys.executable, str(ROOT / "export_sources.py"), "--check"], check=True)
    for name, expected_count in (("transfer", 10), ("hold", 9)):
        artifact = json.loads((ROOT / ("reference/" + name + ".json")).read_text(encoding="utf-8"))
        if artifact["noir_version"] != manifest["noir_version"]:
            raise ValueError("compiler version mismatch: " + name)
        public = [item for item in artifact["abi"]["parameters"] if item["visibility"] == "public"]
        source = (ROOT / name / "src/main.nr").read_text(encoding="utf-8")
        names = re.findall(r"^\s*(\w+): pub ", source, re.MULTILINE)
        if names != [item["name"] for item in public]:
            raise ValueError("source/reference public-input order differs: " + name)
        count = sum(field_count(item["type"]) for item in public)
        if count != expected_count:
            raise ValueError("unexpected public-input count: " + name)
        print(name + ": " + str(count) + " public inputs; source order matches reference ABI")
    print("PASS: " + str(len(manifest["files"])) + " file hashes and saved source/artifact data verified offline.")
    print("Not checked: Noir compilation, proof generation from rebuilt sources, or verifier equivalence.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
