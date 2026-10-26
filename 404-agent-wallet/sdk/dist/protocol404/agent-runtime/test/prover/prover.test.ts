import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_PUBLIC_INPUTS,
  SHIPPED_CRS,
  assertPublicInputLayout,
  fetchPinnedBytes,
  type Hex,
} from "../../src/prover/index.ts";

const protocol404Root = new URL("../../../", import.meta.url);

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(new URL(path, protocol404Root))).digest("hex");
}

test("shipped CRS and historical circuit modules are byte-identical to pinned resources", async () => {
  assert.equal(await sha256(`agent-runtime/public/${SHIPPED_CRS.g1.file}`), SHIPPED_CRS.g1.sha256);
  assert.equal(await sha256(`agent-runtime/public/${SHIPPED_CRS.g2.file}`), SHIPPED_CRS.g2.sha256);
  assert.equal(await sha256("agent-runtime/public/assets/transfer-BxYyEYeL.js"), "5fed80bfb8b27be47648d6f37cf31b5432db71c587293bfb83f405156b3c18c1");
  assert.equal(await sha256("agent-runtime/public/assets/hold-KmcNW90K.js"), "e5fae096d54944d7dc1d8b5a782a57c9863c030fb24a164a9cf8b8c393bab05c");
});

test("pinned loader accepts exact bytes and rejects altered bytes", async () => {
  const bytes = new TextEncoder().encode("pinned resource");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fakeFetch: typeof fetch = async () => new Response(bytes);

  assert.deepEqual(await fetchPinnedBytes("fixture", digest, fakeFetch), bytes);
  await assert.rejects(fetchPinnedBytes("fixture", "0".repeat(64), fakeFetch), /does not match its pinned hash/);
});

test("historical artifact public parameter order matches verifier proof layouts", async () => {
  const expected = {
    transfer: ["root", "nullifiers", "commitments", "now", "asset", "public_out", "fee", "ext_hash"],
    hold: ["root", "threshold", "min_lock", "campaign_id", "binding", "tags"],
  } as const;

  for (const circuit of ["transfer", "hold"] as const) {
    const artifact = JSON.parse(await readFile(new URL(`circuits/${circuit}.json`, protocol404Root), "utf8")) as {
      abi: { parameters: Array<{ name: string; visibility: string; type: { kind: string; length?: number } }> };
    };
    const publicParameters = artifact.abi.parameters.filter((parameter) => parameter.visibility === "public");
    assert.deepEqual(publicParameters.map((parameter) => parameter.name), [...expected[circuit]]);
    assert.equal(
      publicParameters.reduce((count, parameter) => count + (parameter.type.kind === "array" ? parameter.type.length ?? 0 : 1), 0),
      EXPECTED_PUBLIC_INPUTS[circuit],
    );
  }

  const field = `0x${"00".repeat(32)}` as Hex;
  assert.doesNotThrow(() => assertPublicInputLayout("transfer", { proof: "0x00", publicInputs: Array(10).fill(field) }));
  assert.throws(() => assertPublicInputLayout("transfer", { proof: "0x00", publicInputs: Array(9).fill(field) }), /expected 10/);
});

test("current transfer artifact is u32 and byte-identical to its public module", async () => {
  let artifactText: string;
  try {
    artifactText = await readFile(new URL("circuits/u32/transfer.json", protocol404Root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Missing current u32 transfer artifact: compile circuits/u32/transfer before testing or publishing");
    }
    throw error;
  }
  const artifact = JSON.parse(artifactText) as {
    abi?: { parameters?: Array<{ name: string; visibility?: string; type: { kind?: string; sign?: string; width?: number } }> };
  };
  const asset = artifact.abi?.parameters?.find((parameter) => parameter.name === "asset");
  assert.equal(asset?.visibility, "public", "current transfer artifact asset must be public");
  assert.deepEqual(asset?.type, { kind: "integer", sign: "unsigned", width: 32 }, "current transfer artifact must expose a public u32 asset");

  let publicModule: string;
  try {
    publicModule = await readFile(new URL("agent-runtime/public/assets/transfer-u32.js", protocol404Root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Missing public u32 transfer module: rebuild the browser circuit artifact before publishing");
    }
    throw error;
  }
  assert.equal(publicModule, `export default ${JSON.stringify(artifact)};\n`, "public u32 transfer module differs from the compiled artifact");
});
