#!/usr/bin/env python3
"""Extract source data from the saved JS literals without executing JavaScript."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare the export with its saved inputs without writing")
    check = parser.parse_args().check
    spec = importlib.util.spec_from_file_location("jslit", ROOT / "tools/jslit.py")
    jslit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(jslit)
    output, provenance = {}, {}
    bundles = {"transfer": "transfer-BxYyEYeL.js", "hold": "hold-KmcNW90K.js"}
    for name, filename in bundles.items():
        relative = "reference/bundles/" + filename
        source = (ROOT / relative).read_text(encoding="utf-8")
        matches = list(re.finditer(r"JSON\.parse\(", source))
        if len(matches) != 1:
            raise ValueError("expected exactly one source file_map in " + filename)
        literal = jslit.P(source)
        literal.i = matches[0].end()
        file_map = json.loads(literal.value())
        wanted = {
            "/circuits/" + name + "/src/main.nr": name + "/src/main.nr",
            "pm_lib/lib.nr": "pm_lib/src/lib.nr",
            "pm_lib/hash.nr": "pm_lib/src/hash.nr",
            "std/hash/mod.nr": "reference/stdlib/hash.nr",
        }
        extracted = set()
        for file_id, item in file_map.items():
            destination = wanted.get(item["path"])
            if destination is None:
                continue
            payload = item["source"].encode("utf-8")
            if destination in output and output[destination] != payload:
                raise ValueError("the two circuits disagree on shared source " + destination)
            output[destination] = payload
            provenance.setdefault(destination, []).append({"bundle": relative, "file_map_id": file_id, "source_path": item["path"]})
            extracted.add(item["path"])
        if extracted != set(wanted):
            raise ValueError("missing source files in " + filename)
        artifact = {}
        for variable, key in (("e", "noir_version"), ("t", "hash"), ("n", "abi"), ("r", "bytecode")):
            match = re.search(r"(?:\bvar\s+|,)" + variable + "=", source)
            if match is None:
                raise ValueError("missing artifact field " + key)
            literal.i = match.end()
            artifact[key] = literal.value()
        # The restored JSON stores the decimal hash as a number; JS exports a string.
        artifact["hash"] = int(artifact["hash"])
        saved = json.loads((ROOT / ("reference/" + name + ".json")).read_text(encoding="utf-8"))
        if artifact != saved:
            raise ValueError("saved artifact differs from bundle: " + name)
    output["pm_lib/src/domains.nr"] = (ROOT / "reference/domains.nr").read_bytes()
    provenance["pm_lib/src/domains.nr"] = [{"file": "reference/domains.nr", "kind": "reconstructed keccak256 protocol-domain constants; absent from original file_map"}]
    for relative, payload in output.items():
        path = ROOT / relative
        if check:
            if not path.is_file() or path.read_bytes() != payload:
                raise ValueError("export differs: " + relative)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
    tracked = sorted(set(output) | {"reference/transfer.json", "reference/hold.json", "reference/domains.nr", "tools/jslit.py", "toolchain.json", ".nargo-version", "Nargo.toml", "transfer/Nargo.toml", "hold/Nargo.toml", "pm_lib/Nargo.toml"} | {"reference/bundles/" + filename for filename in bundles.values()})
    manifest = {
        "noir_version": "1.0.0-beta.25+75061fab15986eedee4e7d9104ff87dd9fa4ca10",
        "files": {relative: hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() for relative in tracked},
        "limits": "Source export and artifact identity are checked. Recompilation and equivalence to the deployed verifier have not been established.",
    }
    manifest_path = ROOT / "manifest.json"
    if check:
        if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
            raise ValueError("manifest differs from saved inputs")
    else:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Source export " + ("checked" if check else "written") + ": 5 protocol files + 1 standard-library snapshot; no JavaScript executed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
