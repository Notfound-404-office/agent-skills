import { n as acvmWasm } from "./vendor/acvm_js.js";
import { a as noircAbiWasm } from "./vendor/noirc_abi_wasm.js";
import {
  Barretenberg,
  Noir,
  UltraHonkBackend,
  type BarretenbergOptions,
  type CircuitArtifact,
} from "./vendor/original-prover.js";
import { bytesToHex, hexToBytes } from "./runtime.ts";
import { importPublic } from "./vendor/public-loader.ts";

export type Hex = `0x${string}`;
export type ProverInputs = Record<string, unknown>;
export type CircuitName = "transfer" | "hold";
export type ProverCreateOptions = BarretenbergOptions & {
  readonly fetchImplementation?: typeof fetch;
};

export interface UltraHonkProof {
  readonly proof: Hex;
  readonly publicInputs: readonly Hex[];
}

export interface BrowserProver {
  prove(circuit: CircuitName, inputs: ProverInputs): Promise<UltraHonkProof>;
  proveTransfer(inputs: ProverInputs): Promise<UltraHonkProof>;
  proveHold(inputs: ProverInputs): Promise<UltraHonkProof>;
  verify(circuit: CircuitName, proof: UltraHonkProof): Promise<boolean>;
  destroy(): Promise<void>;
}

export const PROVER_ASSETS = Object.freeze({
  acvmWasm: "/assets/acvm_js_bg-BawCIsJQ.wasm",
  noircAbiWasm: "/assets/noirc_abi_wasm_bg-VozwQxgy.wasm",
});

export const EXPECTED_PUBLIC_INPUTS = Object.freeze({ transfer: 10, hold: 9 });

export const SHIPPED_CRS = Object.freeze({
  points: 2 ** 17,
  g1: {
    file: "crs/bn254_g1_compressed_131072.dat",
    sha256: "fad8203ae1fd103658d4bb33b2b4cf126a28352b5de4684737cff23cc15fb94b",
  },
  g2: {
    file: "crs/bn254_g2.dat",
    sha256: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
  },
});

const EVM_PROOF_OPTIONS = Object.freeze({ verifierTarget: "evm" as const });

export const EVM_CIRCUIT_SETTINGS = Object.freeze({
  ipaAccumulation: false,
  oracleHashType: "keccak" as const,
  disableZk: false,
  optimizedSolidityVerifier: false,
});

const CIRCUIT_PATHS: Readonly<Record<CircuitName, string>> = Object.freeze({
  transfer: "/assets/transfer-u32.js",
  hold: "/assets/hold-KmcNW90K.js",
});

interface LoadedCircuit {
  readonly noir: Noir;
  readonly backend: UltraHonkBackend;
}

/** Loads this version's artifact; never falls back to a legacy transfer circuit. */
async function loadCircuitArtifact(circuit: CircuitName): Promise<CircuitArtifact> {
  const module = (await importPublic(CIRCUIT_PATHS[circuit])) as { default: CircuitArtifact };
  if (circuit === 'transfer') {
    const asset = (module.default.abi as { parameters: { name: string; type: { width?: number } }[] })
      .parameters.find(parameter => parameter.name === 'asset');
    if (asset?.type.width !== 32) throw new Error('The u32 transfer circuit must be rebuilt for this deployment.');
  }
  return module.default;
}

/** Readable application wrapper around generated Noir and Barretenberg modules. @orig web-ref/pretty/prover-BvfOBkSi.js:5837 uu */
export class Prover implements BrowserProver {
  readonly #api: Barretenberg;
  readonly #circuits: Readonly<Record<CircuitName, LoadedCircuit>>;

  private constructor(api: Barretenberg, circuits: Record<CircuitName, LoadedCircuit>) {
    this.#api = api;
    this.#circuits = circuits;
  }

  public static async create(options: ProverCreateOptions = {}): Promise<Prover> {
    const api = await Barretenberg.new(options);
    try {
      const [transferArtifact, holdArtifact] = await Promise.all([
        loadCircuitArtifact("transfer"),
        loadCircuitArtifact("hold"),
      ]);
      return new Prover(api, {
        transfer: {
          noir: new Noir(transferArtifact),
          backend: new UltraHonkBackend(transferArtifact.bytecode, api),
        },
        hold: {
          noir: new Noir(holdArtifact),
          backend: new UltraHonkBackend(holdArtifact.bytecode, api),
        },
      });
    } catch (error) {
      await api.destroy().catch(() => undefined);
      throw error;
    }
  }

  /** Loads shipped BN254 parameters after checking their shape against both circuits. @orig web-ref/pretty/prover-BvfOBkSi.js:5859 loadSrs */
  public async loadSrs(crs: { g1: Uint8Array; g2: Uint8Array }): Promise<number> {
    const sizes = await Promise.all(
      Object.values(this.#circuits).map(async ({ backend }) => {
        const stats = await this.#api.circuitStats({
          circuit: {
            name: "",
            bytecode: backend.acirUncompressedBytecode,
            verificationKey: new Uint8Array(),
          },
          includeGatesPerOpcode: false,
          settings: EVM_CIRCUIT_SETTINGS,
        });
        return stats.numGatesDyadic;
      }),
    );
    const requiredPoints = Math.max(...sizes);
    const shippedPoints = crs.g1.length / 32;
    if (
      !Number.isInteger(shippedPoints) ||
      shippedPoints < requiredPoints ||
      shippedPoints % SHIPPED_CRS.points !== 0 ||
      crs.g2.length !== 128
    ) {
      throw new Error(
        `shipped CRS has ${crs.g1.length} G1 bytes and ${crs.g2.length} G2 bytes; the circuits need ${requiredPoints} points`,
      );
    }
    await this.#api.srsInitSrs({ pointsBuf: crs.g1, numPoints: shippedPoints, g2Point: crs.g2 });
    return shippedPoints;
  }

  /** Executes Noir and emits EVM-target UltraHonk proof bytes. @orig web-ref/pretty/prover-BvfOBkSi.js:5894 prove */
  public async prove(circuit: CircuitName, inputs: ProverInputs): Promise<UltraHonkProof> {
    const loaded = this.#circuits[circuit];
    const { witness } = await loaded.noir.execute(inputs);
    const result = await loaded.backend.generateProof(witness, EVM_PROOF_OPTIONS);
    const proof = {
      proof: bytesToHex(result.proof),
      publicInputs: result.publicInputs.map(
        (input) => `0x${BigInt(input).toString(16).padStart(64, "0")}` as Hex,
      ),
    };
    assertPublicInputLayout(circuit, proof);
    return proof;
  }

  public proveTransfer(inputs: ProverInputs): Promise<UltraHonkProof> {
    return this.prove("transfer", inputs);
  }

  public proveHold(inputs: ProverInputs): Promise<UltraHonkProof> {
    return this.prove("hold", inputs);
  }

  /** Verifies locally and preserves the original false-on-backend-error behavior. @orig web-ref/pretty/prover-BvfOBkSi.js:5906 verify */
  public async verify(circuit: CircuitName, proof: UltraHonkProof): Promise<boolean> {
    if (proof.publicInputs.length !== EXPECTED_PUBLIC_INPUTS[circuit]) return false;
    try {
      return await this.#circuits[circuit].backend.verifyProof(
        { proof: hexToBytes(proof.proof), publicInputs: proof.publicInputs },
        EVM_PROOF_OPTIONS,
      );
    } catch {
      return false;
    }
  }

  public destroy(): Promise<void> {
    return this.#api.destroy();
  }
}

/** Fetches one immutable resource and rejects altered bytes before use. @orig web-ref/pretty/index-CVtw0LZh.js:22456 lE */
export async function fetchPinnedBytes(
  file: string,
  expectedSha256: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImplementation(`/${file}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`could not load ${file} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actualSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${file} does not match its pinned hash; the site may be serving a damaged or altered copy`);
  }
  return bytes;
}

/** Uses one worker per logical core when isolation permits shared memory. @orig web-ref/pretty/index-CVtw0LZh.js:22455 cE */
export function recommendedProverThreads(): number {
  return globalThis.crossOriginIsolated ? Math.min(globalThis.navigator?.hardwareConcurrency || 1, 16) : 1;
}

/** Rejects proof output whose public-input layout cannot match the verifier. */
export function assertPublicInputLayout(circuit: CircuitName, proof: UltraHonkProof): void {
  const expected = EXPECTED_PUBLIC_INPUTS[circuit];
  if (proof.publicInputs.length !== expected) {
    throw new Error(`${circuit} proof has ${proof.publicInputs.length} public inputs; expected ${expected}`);
  }
  if (!/^0x(?:[0-9a-f]{2})+$/.test(proof.proof)) throw new Error("proof is not hexadecimal bytes");
  for (const input of proof.publicInputs) {
    if (!/^0x[0-9a-f]{64}$/.test(input)) throw new Error("public input is not a 32-byte field");
  }
}

/** Initializes WASM, starts Barretenberg and loads hash-pinned CRS. @orig web-ref/pretty/index-CVtw0LZh.js:22466 uE */
export async function createProver(options: ProverCreateOptions = {}): Promise<BrowserProver> {
  const { fetchImplementation = fetch, ...backendOptions } = options;
  const crsPromise = Promise.all([
    fetchPinnedBytes(SHIPPED_CRS.g1.file, SHIPPED_CRS.g1.sha256, fetchImplementation),
    fetchPinnedBytes(SHIPPED_CRS.g2.file, SHIPPED_CRS.g2.sha256, fetchImplementation),
  ]);
  crsPromise.catch(() => undefined);
  await Promise.all([
    acvmWasm.default({ module_or_path: fetchImplementation(PROVER_ASSETS.acvmWasm) }),
    noircAbiWasm.default({ module_or_path: fetchImplementation(PROVER_ASSETS.noircAbiWasm) }),
  ]);
  const prover = await Prover.create({
    ...backendOptions,
    threads: backendOptions.threads ?? recommendedProverThreads(),
    skipSrsInit: true,
  });
  try {
    const [g1, g2] = await crsPromise;
    await prover.loadSrs({ g1, g2 });
    return prover;
  } catch (error) {
    await prover.destroy().catch(() => undefined);
    throw error;
  }
}

let sharedProver: Promise<BrowserProver> | undefined;

/** Returns a shared prover and clears a failed initialization for retry. */
export function getProver(): Promise<BrowserProver> {
  sharedProver ??= createProver().catch((error: unknown) => {
    sharedProver = undefined;
    throw error;
  });
  return sharedProver;
}

/** Starts the same shared prover used by proof generation so UI idle time can absorb cold startup. */
export async function prewarmProver(): Promise<void> {
  await getProver();
}

export async function proveTransfer(inputs: ProverInputs): Promise<UltraHonkProof> {
  return (await getProver()).proveTransfer(inputs);
}

export async function proveHold(inputs: ProverInputs): Promise<UltraHonkProof> {
  return (await getProver()).proveHold(inputs);
}
