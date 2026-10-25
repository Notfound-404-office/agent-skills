# Bundled Protocol 404 SDK

This directory makes the wallet skill self-contained. It includes:

- `dist/protocol404/frontend/src`: wallet, note, proof and transaction preparation code;
- `dist/protocol404/relayer/src`: ABI, validators, portable transaction and indexer code;
- `dist/protocol404/circuits`: original, u32 and review circuit sources/artifacts;
- `bsc-mainnet/circuits`: release circuit sources and generated artifact manifests;
- `bsc-mainnet/contracts`: matching source-owned contracts and generated verifiers;
- `.proof-assets`: pinned WASM, Barretenberg and CRS files;
- `scripts/proof-assets.py`: SHA-256 checked proof-resource restore.

`scripts/setup.mjs` installs the locked frontend and relayer dependencies and restores
the six proof assets into the frontend public directory. No external SDK repository is
required for the bundled path.
