#!/usr/bin/env python3
"""Store/restore pinned proof resources as complete, checksum-verified files."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = '.proof-assets/manifest.json'


def inside(root, relative):
    root = root.resolve()
    path = (root / relative).resolve()
    if root not in path.parents:
        raise ValueError('asset path escapes repository')
    return path


def pack(root):
    public = root / 'dist/protocol404/frontend/public'
    files = sorted([*(public / 'assets').glob('*.wasm'), *(public / 'assets').glob('barretenberg-*.js'), *(public / 'crs').glob('*.dat')])
    if len(files) != 6:
        raise ValueError('expected all six original proof resources before packaging')
    old_manifest_path = inside(root, MANIFEST)
    old_manifest = json.loads(old_manifest_path.read_text()) if old_manifest_path.exists() else []
    manifest = []
    for path in files:
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        paths = [str(path.relative_to(root))]
        mirror = root / 'web-ref' / path.relative_to(public)
        if mirror.exists():
            if mirror.read_bytes() != data:
                raise ValueError(f'reference differs: {mirror.name}')
            paths.append(str(mirror.relative_to(root)))
        source = f'.proof-assets/{digest}/{path.name}'
        target = inside(root, source)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        if target.stat().st_size != len(data) or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError(f'failed to preserve complete asset: {path.name}')
        manifest.append({'paths': paths, 'source': source, 'size': len(data), 'sha256': digest})
    old_manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

    # Remove only shards named by the previous manifest, and only after every
    # complete replacement has been written and verified.
    for asset in old_manifest:
        for relative in asset.get('parts', []):
            part = inside(root, relative)
            if part.exists():
                part.unlink()
            if part.parent.exists() and not any(part.parent.iterdir()):
                part.parent.rmdir()
    print(f'Stored {len(manifest)} complete resources; {sum(item["size"] for item in manifest)} bytes')


def restore(root):
    manifest = json.loads(inside(root, MANIFEST).read_text())
    restored = 0
    for asset in manifest:
        source = inside(root, asset['source'])
        data = source.read_bytes()
        if len(data) != asset['size'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
            raise ValueError(f'pinned asset checksum mismatch: {asset["source"]}')
        missing = []
        for relative in asset['paths']:
            path = inside(root, relative)
            if path.exists():
                if hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                    raise ValueError(f'existing asset differs from pinned source: {relative}')
            else:
                missing.append(path)
        if not missing:
            continue
        for path in missing:
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, path)
            restored += 1
    print(f'Proof assets SHA-256 verified; restored {restored} files')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['pack', 'restore'])
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    {'pack': pack, 'restore': restore}[args.command](args.root.resolve())
