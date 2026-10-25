import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import {
  IncrementalMerkleTree,
  buildTransferWitness,
  createNote,
  deriveAddress,
  deriveKeys,
  deriveNoteSecrets,
  noteCommitment,
} from "../src/crypto/index.ts";
import { createProver, type Hex } from "../src/prover/index.ts";

/** Serve only checked-in prover resources; no request can leave the host. */
const localFetch: typeof fetch = async (input) => {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  const pathname = new URL(raw, "http://protocol404.local").pathname;
  if (!pathname.startsWith("/assets/") && !pathname.startsWith("/crs/")) {
    throw new Error(`local prover fetch refused ${pathname}`);
  }
  const file = new URL(`../public${pathname}`, import.meta.url);
  const headers = pathname.endsWith(".wasm") ? { "content-type": "application/wasm" } : undefined;
  return new Response(new Uint8Array(await readFile(file)), { headers });
};

const fieldHex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;

function deterministicTransfer() {
  const keys = deriveKeys(new Uint8Array(32));
  const recipient = deriveAddress(keys, new Uint8Array(11));
  const input = createNote(recipient, 50n, {
    rseed: new Uint8Array(32).fill(1),
    lockUntil: 7n,
  });
  const inputCommitment = noteCommitment(
    input,
    recipient.owner,
    deriveNoteSecrets(input.rseed).rcm,
  );
  const tree = new IncrementalMerkleTree();
  tree.insertSingle(inputCommitment);
  const output0 = {
    to: recipient,
    note: createNote(recipient, 40n, { rseed: new Uint8Array(32).fill(2) }),
  };
  const output1 = {
    to: recipient,
    note: createNote(recipient, 5n, { rseed: new Uint8Array(32).fill(3) }),
  };
  return buildTransferWitness({
    keys,
    tree,
    inputs: [{ note: input, leafIndex: 0 }, null],
    outputs: [output0, output1],
    now: 100n,
    fee: 5n,
    publicOut: 0n,
    extHash: 9n,
    rng: (length) => new Uint8Array(length).fill(length === 11 ? 4 : 5),
  });
}

const witness = deterministicTransfer();
const expectedPublicInputs = [
  witness.pub.root,
  ...witness.pub.nullifiers,
  ...witness.pub.commitments,
  witness.pub.now,
  BigInt(witness.pub.asset),
  witness.pub.publicOut,
  witness.pub.fee,
  witness.pub.extHash,
].map(fieldHex);

const started = performance.now();
const prover = await createProver({
  backend: "Wasm",
  threads: 1,
  fetchImplementation: localFetch,
});
try {
  const proof = await prover.proveTransfer(witness.inputs);
  assert.deepEqual(proof.publicInputs, expectedPublicInputs, "proof public inputs differ from the witness");
  assert.equal(await prover.verify("transfer", proof), true, "generated proof did not verify locally");
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error("--output requires a file path");
    await writeFile(output, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({
    verified: true,
    publicInputs: proof.publicInputs.length,
    proofBytes: (proof.proof.length - 2) / 2,
    elapsedMs: Math.round(performance.now() - started),
  }));
} finally {
  await prover.destroy();
}
