export interface CircuitArtifact {
  readonly bytecode: string;
  readonly abi: unknown;
}

export class Noir {
  public constructor(artifact: CircuitArtifact);
  public execute(inputs: Record<string, unknown>): Promise<{ witness: Uint8Array }>;
}

export interface BackendProof {
  readonly proof: Uint8Array;
  readonly publicInputs: readonly string[];
}

export class UltraHonkBackend {
  readonly acirUncompressedBytecode: Uint8Array;
  public constructor(bytecode: string, api: Barretenberg);
  public generateProof(witness: Uint8Array, options: { verifierTarget: "evm" }): Promise<BackendProof>;
  public verifyProof(
    proof: { proof: Uint8Array; publicInputs: readonly string[] },
    options: { verifierTarget: "evm" },
  ): Promise<boolean>;
}

export interface BarretenbergOptions {
  readonly threads?: number;
  readonly skipSrsInit?: boolean;
  readonly logger?: (message: string) => void;
  readonly backend?: "Wasm" | "WasmWorker" | "NativeUnixSocket" | "NativeSharedMemory";
}

export class Barretenberg {
  static new(options?: BarretenbergOptions): Promise<Barretenberg>;
  circuitStats(input: {
    circuit: { name: string; bytecode: Uint8Array; verificationKey: Uint8Array };
    includeGatesPerOpcode: false;
    settings: {
      readonly ipaAccumulation: false;
      readonly oracleHashType: "keccak";
      readonly disableZk: false;
      readonly optimizedSolidityVerifier: false;
    };
  }): Promise<{ numGatesDyadic: number }>;
  srsInitSrs(input: { pointsBuf: Uint8Array; numPoints: number; g2Point: Uint8Array }): Promise<unknown>;
  destroy(): Promise<void>;
}
