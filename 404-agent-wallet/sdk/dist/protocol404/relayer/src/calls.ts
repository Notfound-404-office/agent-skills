import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { protocol404PoolAbi, protocol404BundleAbi, protocol404MarketAbi, protocol404MarketV2Abi, protocol404MintAbi } from "./abi.js";
import { validateAction, validateFill, validateMint, validatePlace, validateRelease, validateSweep, validateTransaction, type ContractAction, type FillRequest, type PrivateTransaction, type SignedRelease, type SweepRequest } from "./validators.js";

export type Contracts = { pool: Address; market: Address; mint: Address; bundle: Address; marketVersion?: 1 | 2 };
export type RelayPricing = { version: 2; gasLimit: bigint; gasPriceWei: bigint; markupBps: 500 };
export type RelayCall = { to: Address; data: Hex; nullifiers: string[]; pricing?: RelayPricing; feeTx?: PrivateTransaction; release?: { signed: SignedRelease; direct: boolean } };

function pricing(body: unknown): RelayPricing | undefined {
  const value = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).pricing : undefined;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad request: pricing");
  const input = value as Record<string, unknown>;
  if (input.version !== 2 || input.markupBps !== 500 || typeof input.gasLimit !== "string" || !/^[1-9][0-9]{0,77}$/.test(input.gasLimit) || typeof input.gasPriceWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(input.gasPriceWei)) {
    throw new Error("bad request: pricing");
  }
  const gasLimit = BigInt(input.gasLimit);
  const gasPriceWei = BigInt(input.gasPriceWei);
  if (gasLimit >= 1n << 256n || gasPriceWei >= 1n << 256n) throw new Error("bad request: pricing");
  return { version: 2, gasLimit, gasPriceWei, markupBps: 500 };
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireCaller(tx: PrivateTransaction, expected: Address): void {
  if (!sameAddress(tx.ext.caller, expected)) throw new Error("bad request: caller");
}

function requireData(tx: PrivateTransaction, expected: Hex): void {
  if (tx.ext.data.toLowerCase() !== expected.toLowerCase()) throw new Error("bad request: contract data");
}

function placeData(place: { buyAmount: string; maker: Address }): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [BigInt(place.buyAmount), place.maker]));
}

function fillData(fill: FillRequest["fill"], marketVersion: 1 | 2): Hex {
  if (marketVersion === 2) return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes32" }],
    [BigInt(fill.orderId), BigInt(fill.pay as string), BigInt(fill.outInner), keccak256(fill.outCiphertext)],
  ));
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [BigInt(fill.orderId), BigInt(fill.outInner), keccak256(fill.outCiphertext)],
  ));
}

function sweepData(sweep: SweepRequest["sweep"]): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint64[]" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [sweep.orderIds.map(BigInt), sweep.pays.map(BigInt), BigInt(sweep.minBought), BigInt(sweep.boughtInner), keccak256(sweep.boughtCiphertext), BigInt(sweep.restInner), keccak256(sweep.restCiphertext)],
  ));
}

function marketVersion(contracts: Contracts): 1 | 2 { return contracts.marketVersion ?? 1; }
function marketAbi(contracts: Contracts) { return marketVersion(contracts) === 2 ? protocol404MarketV2Abi : protocol404MarketAbi; }

function encodeFillCall(tx: PrivateTransaction, fill: FillRequest["fill"], version: 1 | 2): Hex {
  if (version === 2) return encodeFunctionData({ abi: protocol404MarketV2Abi, functionName: "fillPrivate", args: [...txArgs(tx), {
    orderId: BigInt(fill.orderId), pay: BigInt(fill.pay as string), outInner: BigInt(fill.outInner), outCiphertext: fill.outCiphertext,
  }] });
  return encodeFunctionData({ abi: protocol404MarketAbi, functionName: "fillPrivate", args: [...txArgs(tx), {
    orderId: BigInt(fill.orderId), outInner: BigInt(fill.outInner), outCiphertext: fill.outCiphertext,
  }] });
}

function requireActionBinding(action: ContractAction, contracts: Contracts): void {
  if (action.kind === "transact" || action.kind === "release") return;
  requireCaller(action.tx, contracts.market);
  requireData(action.tx, action.kind === "place" ? placeData(action.place) : fillData(action.fill, marketVersion(contracts)));
}

function txArgs(tx: PrivateTransaction) {
  return [tx.proof, {
    root: BigInt(tx.pub.root),
    nullifiers: tx.pub.nullifiers.map(BigInt) as [bigint, bigint],
    commitments: tx.pub.commitments.map(BigInt) as [bigint, bigint],
    nowTs: BigInt(tx.pub.nowTs), asset: Number(tx.pub.asset), publicOut: BigInt(tx.pub.publicOut), fee: BigInt(tx.pub.fee),
  }, {
    recipient: tx.ext.recipient, relayer: tx.ext.relayer, caller: tx.ext.caller,
    data: tx.ext.data, ciphertexts: tx.ext.ciphertexts,
  }] as const;
}

/** @orig pretty/index-CVtw0LZh.js:26709 rD */
function actionCall(action: ContractAction, contracts: Contracts): { to: Address; data: Hex } {
  switch (action.kind) {
    case "transact": return { to: contracts.pool, data: encodeFunctionData({ abi: protocol404PoolAbi, functionName: "transact", args: txArgs(action.tx) }) };
    case "place": return { to: contracts.market, data: encodeFunctionData({ abi: marketAbi(contracts), functionName: "placeOrder", args: [...txArgs(action.tx), { buyAmount: BigInt(action.place.buyAmount), maker: action.place.maker }] }) };
    case "fill": return { to: contracts.market, data: encodeFillCall(action.tx, action.fill, marketVersion(contracts)) };
    case "release": return { to: contracts.market, data: encodeRelease(action.release, contracts) };
  }
}

function encodeRelease(input: SignedRelease, contracts?: Contracts): Hex {
  const value = input.release;
  return encodeFunctionData({ abi: contracts ? marketAbi(contracts) : protocol404MarketAbi, functionName: "release", args: [input.action, { orderId: BigInt(value.orderId), inner: BigInt(value.inner), ciphertext: value.ciphertext, relayer: value.relayer, fee: BigInt(value.fee), deadline: BigInt(value.deadline) }, input.signature] });
}

/** Decode and encode exactly the request shapes used by the original client. */
export function prepareCall(path: string, body: unknown, contracts: Contracts): RelayCall {
  const requestPricing = pricing(body);
  if (path === "/relay") {
    const tx = validateTransaction(body);
    requireCaller(tx, "0x0000000000000000000000000000000000000000");
    return { to: contracts.pool, data: encodeFunctionData({ abi: protocol404PoolAbi, functionName: "transact", args: txArgs(tx) }), nullifiers: [...tx.pub.nullifiers], pricing: requestPricing, feeTx: tx };
  }
  if (path === "/order") {
    const value = validatePlace(body);
    requireCaller(value.tx, contracts.market);
    requireData(value.tx, placeData(value.place));
    return { to: contracts.market, data: encodeFunctionData({ abi: marketAbi(contracts), functionName: "placeOrder", args: [...txArgs(value.tx), { buyAmount: BigInt(value.place.buyAmount), maker: value.place.maker }] }), nullifiers: [...value.tx.pub.nullifiers], pricing: requestPricing, feeTx: value.tx };
  }
  if (path === "/fill") {
    const version = marketVersion(contracts);
    const value = validateFill(body, version);
    requireCaller(value.tx, contracts.market);
    requireData(value.tx, fillData(value.fill, version));
    return { to: contracts.market, data: encodeFillCall(value.tx, value.fill, version), nullifiers: [...value.tx.pub.nullifiers], pricing: requestPricing, feeTx: value.tx };
  }
  if (path === "/sweep") {
    if (marketVersion(contracts) !== 2) throw new Error("bad request: sweep requires market v2");
    const value = validateSweep(body);
    requireCaller(value.tx, contracts.market);
    requireData(value.tx, sweepData(value.sweep));
    const sweep = value.sweep;
    return { to: contracts.market, data: encodeFunctionData({ abi: protocol404MarketV2Abi, functionName: "sweepPrivate", args: [...txArgs(value.tx), {
      orderIds: sweep.orderIds.map(BigInt), pays: sweep.pays.map(BigInt), minBought: BigInt(sweep.minBought),
      boughtInner: BigInt(sweep.boughtInner), boughtCiphertext: sweep.boughtCiphertext,
      restInner: BigInt(sweep.restInner), restCiphertext: sweep.restCiphertext,
    }] }), nullifiers: [...value.tx.pub.nullifiers], pricing: requestPricing, feeTx: value.tx };
  }
  if (path === "/mint") {
    const value = validateMint(body);
    requireCaller(value.tx, contracts.mint);
    if (value.tx.pub.asset !== "1") throw new Error("bad request: mint asset");
    requireData(value.tx, keccak256(encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "bytes32[]" }],
      [value.mint.inners.map(BigInt), value.mint.ciphertexts.map(ciphertext => keccak256(ciphertext))],
    )));
    return { to: contracts.mint, data: encodeFunctionData({ abi: protocol404MintAbi, functionName: "privateMint", args: [...txArgs(value.tx), value.mint.inners.map(BigInt), value.mint.ciphertexts] }), nullifiers: [...value.tx.pub.nullifiers], pricing: requestPricing, feeTx: value.tx };
  }
  if (path === "/release") {
    const value = validateRelease(body);
    return { to: contracts.market, data: encodeRelease(value, contracts), nullifiers: [], pricing: requestPricing, release: { signed: value, direct: true } };
  }
  if (path === "/bundle") {
    const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const fee = validateTransaction(input.fee);
    const action = validateAction(input.action, marketVersion(contracts));
    requireCaller(fee, contracts.bundle);
    if (fee.pub.asset !== "1") throw new Error("bad request: bundle fee asset");
    requireActionBinding(action, contracts);
    if (action.kind === "release") {
      if (action.release.release.fee !== "0" || !sameAddress(action.release.release.relayer, "0x0000000000000000000000000000000000000000")) throw new Error("bad request: bundled release fee");
    } else {
      if (action.tx.pub.fee !== "0" || !sameAddress(action.tx.ext.relayer, "0x0000000000000000000000000000000000000000")) throw new Error("bad request: bundled action fee");
      requireCaller(action.tx, action.kind === "transact" ? "0x0000000000000000000000000000000000000000" : contracts.market);
    }
    const nested = actionCall(action, contracts);
    requireData(fee, keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [nested.to, keccak256(nested.data)])));
    const innerNullifiers = action.kind === "release" ? [] : [...action.tx.pub.nullifiers];
    const release = action.kind === "release" ? { signed: action.release, direct: false } : undefined;
    return {
      to: contracts.bundle,
      data: encodeFunctionData({ abi: protocol404BundleAbi, functionName: "relay", args: [...txArgs(fee), nested.to, nested.data] }),
      nullifiers: [...fee.pub.nullifiers, ...innerNullifiers], pricing: requestPricing, feeTx: fee, release,
    };
  }
  throw new Error("not found");
}
