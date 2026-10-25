#!/usr/bin/env python3
"""Require compiled circuit ABI and uncompressed ACIR to match the reference."""
import base64
import gzip
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load(path):
    return json.loads(path.read_text())


def acir(artifact, path):
    try:
        compressed = base64.b64decode(artifact['bytecode'], validate=True)
        return gzip.decompress(compressed)
    except (KeyError, ValueError, gzip.BadGzipFile) as error:
        raise ValueError(f'invalid ACIR bytecode in {path}') from error


def compare(name):
    reference_path = HERE / 'reference' / f'{name}.json'
    compiled_path = HERE / 'target' / f'{name}.json'
    reference = load(reference_path)
    compiled = load(compiled_path)
    if compiled.get('abi') != reference.get('abi'):
        raise ValueError(f'{name}: compiled ABI differs from reference')
    reference_acir = acir(reference, reference_path)
    compiled_acir = acir(compiled, compiled_path)
    if compiled_acir != reference_acir:
        raise ValueError(f'{name}: compiled uncompressed ACIR differs from reference')
    print(f'{name}: ABI exact; ACIR exact ({len(compiled_acir)} bytes)')


if __name__ == '__main__':
    for circuit in ('transfer', 'hold'):
        compare(circuit)
