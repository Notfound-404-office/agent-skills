import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64 = 1n << 64n;
const U32 = 1n << 32n;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const CIPHERTEXT_HEX_LENGTH = 2 + 2 * 175;

export type TxPublic = {
  root: string;
  nullifiers: [string, string];
  commitments: [string, string];
  nowTs: string;
  asset: string;
  publicOut: string;
  fee: string;
};

export type ExtData = {
  recipient: Address;
  relayer: Address;
  caller: Address;
  data: Hex;
  ciphertexts: [Hex, Hex];
};

export type PrivateTransaction = { proof: Hex; pub: TxPublic; ext: ExtData };
export type MintRequest = { tx: PrivateTransaction; mint: { inners: string[]; ciphertexts: Hex[] } };
export type PlaceRequest = { tx: PrivateTransaction; place: { buyAmount: string; maker: Address } };
export type FillRequest = { tx: PrivateTransaction; fill: { orderId: string; pay?: string; outInner: string; outCiphertext: Hex } };
export type SweepRequest = {
  tx: PrivateTransaction;
  sweep: {
    orderIds: string[];
    pays: string[];
    minBought: string;
    boughtInner: string;
    boughtCiphertext: Hex;
    restInner: string;
    restCiphertext: Hex;
  };
};
export type SignedRelease = {
  action: 0 | 1;
  release: { orderId: string; inner: string; ciphertext: Hex; relayer: Address; fee: string; deadline: string };
  signature: Hex;
};

export type ContractAction =
  | { kind: "transact"; tx: PrivateTransaction }
  | ({ kind: "place" } & PlaceRequest)
  | ({ kind: "fill" } & FillRequest)
  | { kind: "release"; release: SignedRelease };

function record(value: unknown, message = "shape"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`bad request: ${message}`);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, limit = 1n << 256n): value is string {
  return typeof value === "string" && DECIMAL.test(value) && BigInt(value) < limit;
}

function address(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value, { strict: false });
}

function ciphertext(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value, { strict: true }) && value.length === CIPHERTEXT_HEX_LENGTH;
}

/** @orig pretty/index-CVtw0LZh.js:26449 BE */
export function validateTransaction(value: unknown): PrivateTransaction {
  const input = record(value);
  const proof = input.proof;
  if (typeof proof !== "string" || !isHex(proof, { strict: true }) || proof.length > 65_538 || proof.length % 2 !== 0) throw new Error("bad request: proof");
  const pub = record(input.pub);
  const nullifiers = pub.nullifiers;
  const commitments = pub.commitments;
  if (!Array.isArray(nullifiers) || !Array.isArray(commitments) || nullifiers.length !== 2 || commitments.length !== 2) throw new Error("bad request: pub");
  const fields = [pub.root, ...nullifiers, ...commitments, pub.nowTs, pub.asset, pub.publicOut, pub.fee];
  if (fields.some(item => !decimal(item))) throw new Error("bad request: pub");
  for (const item of [pub.root, ...nullifiers, ...commitments]) if (BigInt(item as string) >= FIELD_MODULUS) throw new Error("bad request: field element");
  for (const item of [pub.nowTs, pub.publicOut, pub.fee]) if (BigInt(item as string) >= U64) throw new Error("bad request: u64");
  if (BigInt(pub.asset as string) >= U32) throw new Error("bad request: asset out of uint32 range");
  if (pub.asset !== "0" && pub.asset !== "1") throw new Error("bad request: asset");

  const ext = record(input.ext);
  if (![ext.recipient, ext.relayer, ext.caller].every(address)) throw new Error("bad request: address");
  if (typeof ext.data !== "string" || !isHex(ext.data, { strict: true }) || ext.data.length !== 66) throw new Error("bad request: data");
  if (!Array.isArray(ext.ciphertexts) || ext.ciphertexts.length !== 2 || !ext.ciphertexts.every(ciphertext)) throw new Error("bad request: ciphertext");
  return {
    proof,
    pub: {
      root: pub.root as string,
      nullifiers: [nullifiers[0] as string, nullifiers[1] as string],
      commitments: [commitments[0] as string, commitments[1] as string],
      nowTs: pub.nowTs as string,
      asset: pub.asset as string,
      publicOut: pub.publicOut as string,
      fee: pub.fee as string,
    },
    ext: {
      recipient: ext.recipient as Address,
      relayer: ext.relayer as Address,
      caller: ext.caller as Address,
      data: ext.data as Hex,
      ciphertexts: [ext.ciphertexts[0] as Hex, ext.ciphertexts[1] as Hex],
    },
  };
}

/** @orig pretty/index-CVtw0LZh.js:26540 GE */
export function validateMint(value: unknown): MintRequest {
  const input = record(value);
  const mint = record(input.mint);
  const tx = validateTransaction(input.tx);
  if (!Array.isArray(mint.inners) || !Array.isArray(mint.ciphertexts) || mint.inners.length !== 1 || mint.ciphertexts.length !== 1 || !mint.inners.every(item => decimal(item, FIELD_MODULUS)) || !mint.ciphertexts.every(ciphertext)) throw new Error("bad request: mint exactly one lot");
  return { tx, mint: { inners: [...mint.inners] as string[], ciphertexts: [...mint.ciphertexts] as Hex[] } };
}

/** @orig pretty/index-CVtw0LZh.js:26647 $E */
export function validatePlace(value: unknown): PlaceRequest {
  const input = record(value);
  const place = record(input.place);
  const tx = validateTransaction(input.tx);
  if (!decimal(place.buyAmount, U64) || BigInt(place.buyAmount) === 0n || !address(place.maker)) throw new Error("bad request: place");
  return { tx, place: { buyAmount: place.buyAmount, maker: place.maker } };
}

/** @orig pretty/index-CVtw0LZh.js:26664 eD */
export function validateFill(value: unknown, marketVersion: 1 | 2 = 1): FillRequest {
  const input = record(value);
  const fill = record(input.fill);
  const tx = validateTransaction(input.tx);
  if (!decimal(fill.orderId) || !decimal(fill.outInner, FIELD_MODULUS) || !ciphertext(fill.outCiphertext)) throw new Error("bad request: fill");
  if (marketVersion === 2 && (!decimal(fill.pay, U64) || BigInt(fill.pay) === 0n)) throw new Error("bad request: fill pay");
  if (marketVersion === 1 && fill.pay !== undefined) throw new Error("bad request: fill pay requires market v2");
  return { tx, fill: { orderId: fill.orderId, ...(marketVersion === 2 ? { pay: fill.pay as string } : {}), outInner: fill.outInner, outCiphertext: fill.outCiphertext } };
}

export function validateSweep(value: unknown): SweepRequest {
  const input = record(value);
  const sweep = record(input.sweep);
  const tx = validateTransaction(input.tx);
  if (!Array.isArray(sweep.orderIds) || !Array.isArray(sweep.pays) || sweep.orderIds.length < 1 || sweep.orderIds.length > 20 || sweep.orderIds.length !== sweep.pays.length) throw new Error("bad request: sweep items");
  if (!sweep.orderIds.every(item => decimal(item)) || !sweep.pays.every(item => decimal(item, U64) && BigInt(item) > 0n)) throw new Error("bad request: sweep items");
  if (new Set(sweep.orderIds.map(item => BigInt(item).toString())).size !== sweep.orderIds.length) throw new Error("bad request: duplicate order id");
  if (!decimal(sweep.minBought, U64) || !decimal(sweep.boughtInner, FIELD_MODULUS) || !decimal(sweep.restInner, FIELD_MODULUS)) throw new Error("bad request: sweep");
  if (!ciphertext(sweep.boughtCiphertext) || !ciphertext(sweep.restCiphertext)) throw new Error("bad request: sweep ciphertext");
  if (tx.pub.asset !== "1") throw new Error("bad request: sweep asset");
  return { tx, sweep: {
    orderIds: [...sweep.orderIds] as string[], pays: [...sweep.pays] as string[], minBought: sweep.minBought,
    boughtInner: sweep.boughtInner, boughtCiphertext: sweep.boughtCiphertext,
    restInner: sweep.restInner, restCiphertext: sweep.restCiphertext,
  } };
}

/** @orig pretty/index-CVtw0LZh.js:26680 tD */
export function validateRelease(value: unknown): SignedRelease {
  const input = record(value);
  const release = record(input.release);
  if ((input.action !== 0 && input.action !== 1) || !decimal(release.orderId, U64) || !decimal(release.inner, FIELD_MODULUS) || !decimal(release.fee, U64) || !decimal(release.deadline) || !address(release.relayer) || !ciphertext(release.ciphertext)) throw new Error("bad request: release");
  if (typeof input.signature !== "string" || !isHex(input.signature, { strict: true }) || input.signature.length !== 132) throw new Error("bad request: signature");
  return {
    action: input.action,
    release: { orderId: release.orderId, inner: release.inner, ciphertext: release.ciphertext, relayer: release.relayer, fee: release.fee, deadline: release.deadline },
    signature: input.signature,
  };
}

/** @orig pretty/index-CVtw0LZh.js:26759 aD */
export function validateAction(value: unknown, marketVersion: 1 | 2 = 1): ContractAction {
  const input = record(value, "action");
  switch (input.kind) {
    case "transact": return { kind: "transact", tx: validateTransaction(input.tx) };
    case "place": return { kind: "place", ...validatePlace(input) };
    case "fill": return { kind: "fill", ...validateFill(input, marketVersion) };
    case "release": return { kind: "release", release: validateRelease(input.release) };
    default: throw new Error("bad request: action");
  }
}

export { FIELD_MODULUS, U32, U64, CIPHERTEXT_HEX_LENGTH, zeroAddress };
