import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { inspectCommand, verifySubmission } from './sdk.mjs';
import { readPrivateJson, requirePrivateFile, withFileLock, writePrivate } from './file-store.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => hash(JSON.stringify(value));
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const txHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function attemptPath(inspected, dependencies) {
  const directory = dependencies.attemptsRoot ?? join(homedir(), '.local', 'state', 'protocol404', 'baw-attempts');
  const authorizationId = inspected.authorizationId ?? inspected.id;
  return join(directory, `${fingerprint({ chainId: inspected.chainId, id: authorizationId, call: inspected.call })}.json`);
}
async function notAttempted(path) {
  if (await readPrivateJson(path, 'BAW attempt record', null)) throw new Error('BAW_ALREADY_ATTEMPTED: reconcile the existing request; do not submit again');
}

function validatePreview(preview) {
  const simulation = preview?.simulationResult, risks = preview?.risks;
  if (!id(preview?.requestId) || typeof preview.requireConfirmation !== 'boolean'
    || !object(preview.parsedTx) || !Object.keys(preview.parsedTx).length
    || !object(simulation) || !object(risks)
    || !Array.isArray(simulation.balanceChanges) || !Array.isArray(simulation.allowanceChanges)
    || !Array.isArray(simulation.authorityChanges) || !Array.isArray(risks.riskDetails)
    || !object(risks.addresses) || !Array.isArray(risks.riskBehaviors)) throw new Error('BAW_INVALID_PREVIEW');
  // Only accept the success sentinels in the pinned official CLI contract.
  if (simulation.simulationCode !== '000000000' || simulation.simulationErrorDetail !== null
    || simulation.preCheckCode !== '') throw new Error('BAW_SIMULATION_FAILED');
}

export async function runBaw(args, dependencies = {}) {
  let stdout;
  try { ({ stdout } = await (dependencies.exec ?? exec)('baw', [...args, '--json'], { timeout: 180_000, maxBuffer: 2_000_000 })); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('BAW_EXECUTABLE_NOT_FOUND');
    if (error?.killed === true || error?.code === 'ETIMEDOUT') throw new Error('BAW_COMMAND_TIMEOUT: inspect the Binance App; do not automatically repeat execution');
    if (error?.signal) throw new Error(`BAW_COMMAND_SIGNALLED_${String(error.signal).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'UNKNOWN'}: inspect the Binance App; do not automatically repeat execution`);
    const code = String(error?.code ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'UNKNOWN';
    throw new Error(`BAW_COMMAND_EXIT_${code}: inspect the Binance App; do not automatically repeat execution`);
  }
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('BAW_INVALID_RESPONSE'); }
  if (result?.success !== true) {
    const code = String(result?.error?.code ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    throw new Error(`BAW_REJECTED_${code}: stop; do not bypass the wallet risk controls`);
  }
  return result.data;
}

function expiry(value) {
  let number, numeric = true;

  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) throw new Error('BAW_INVALID_EXPIRY');

    numeric = /^\d+$/.test(normalized);
    number = numeric ? Number(normalized) : Date.parse(normalized);
  } else {
    throw new Error('BAW_INVALID_EXPIRY');
  }

  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('BAW_INVALID_EXPIRY');
  }

  // ISO 解析结果已经是毫秒；仅对秒级数字进行转换。
  const milliseconds = numeric && number < 1e12 ? number * 1000 : number;

  if (!Number.isFinite(new Date(milliseconds).getTime())) {
    throw new Error('BAW_INVALID_EXPIRY');
  }

  return milliseconds;
}

async function walletAccess(run, selected, now) {
  const [status, chains, accounts, settings, lock] = await Promise.all([
    run(['wallet', 'status']), run(['wallet', 'chains']), run(['wallet', 'address']),
    run(['wallet', 'settings']), run(['wallet', 'tx-lock', '--binanceChainId', '56']),
  ]);
  if (status?.status !== 'CONNECTED' || !Array.isArray(chains)
    || !chains.some(chain => String(chain.binanceChainId) === '56')) throw new Error('BAW_BSC_NOT_CONNECTED');
  const owned = accounts?.addresses?.filter(account => String(account.binanceChainId) === '56' && address(account.address));
  if (!Array.isArray(owned) || !owned.length) throw new Error('BAW_BSC_ADDRESS_MISSING');
  const from = selected ?? (owned.length === 1 ? owned[0].address : undefined);
  if (!address(from) || !owned.some(account => account.address.toLowerCase() === from.toLowerCase())) throw new Error('BAW_FROM_NOT_OWNED');
  if (settings?.devMode?.enabled !== true) throw new Error('BAW_DEVELOPER_MODE_REQUIRED: enable it in the Binance App');
  if (settings.devMode.expiresAt !== undefined
    && expiry(settings.devMode.expiresAt) <= now()) throw new Error('BAW_DEVELOPER_MODE_EXPIRED');
  if (lock?.status !== 'UNLOCKED') throw new Error('BAW_WALLET_LOCKED: resolve the pending wallet request in the App');
  return from;
}

function statePath(opts) {
  if (!opts.state && !opts.packet) throw new Error('missing state or packet file');
  const path = resolve(opts.state ?? `${opts.packet}.baw.json`);
  if (opts.packet && path === resolve(opts.packet)) throw new Error('state file must differ from the authorization packet');
  return path;
}
async function readState(path) {
  const state = JSON.parse(await requirePrivateFile(path, 'BAW state'));
  if (state?.version !== 1 || state.file !== path || state.chainId !== 56 || !id(state.requestId) || !address(state.from)
    || !id(state.authorizationId) || !address(state.call?.to) || state.call?.value !== '0'
    || !Number.isFinite(state.expiresAt)
    || !['preview', 'executing', 'unknown', 'pending_confirmation', 'broadcasted'].includes(state.phase)) throw new Error('INVALID_BAW_STATE');
  validatePreview(state.preview);
  if (state.preview.requestId !== state.requestId || expiry(state.preview.expiresAt) !== state.expiresAt) {
    throw new Error('INVALID_BAW_STATE: saved preview identity does not match the reviewed request');
  }
  return state;
}
const save = (path, state) => writePrivate(path, `${JSON.stringify(state, null, 2)}\n`);
const authorizationHash = state => fingerprint({ chainId: state.chainId, authorizationId: state.authorizationId, call: state.call });
const reviewHash = state => fingerprint({
  chainId: state.chainId, from: state.from, packet: state.packet, packetHash: state.packetHash,
  authorizationId: state.authorizationId, call: state.call, configHash: state.configHash,
  operation: state.operation, intent: state.intent, requestId: state.requestId,
  expiresAt: state.expiresAt, gasEstimate: state.gasEstimate, preview: state.preview,
});

async function readAttempt(path, state) {
  const attempt = await readPrivateJson(path, 'BAW attempt record', null);
  if (!attempt) return null;
  const legacy = attempt.version === undefined && attempt.state === state.file && attempt.requestId === state.requestId;
  if (legacy) return { attemptedAt: attempt.attemptedAt ?? null, legacy, state: attempt.state, requestId: attempt.requestId };
  if (attempt.version !== 1 || typeof attempt.state !== 'string' || resolve(attempt.state) !== attempt.state
    || !id(attempt.requestId) || attempt.authorizationId !== state.authorizationId
    || (attempt.authorizationHash !== undefined && attempt.authorizationHash !== authorizationHash(state))) {
    throw new Error('INVALID_BAW_ATTEMPT: treat this authorization as attempted and reconcile it manually');
  }
  let canonical = null;
  try { canonical = await readState(attempt.state); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (canonical) {
    if (canonical.chainId !== state.chainId || canonical.authorizationId !== state.authorizationId
      || fingerprint(canonical.call) !== fingerprint(state.call) || canonical.requestId !== attempt.requestId
      || attempt.reviewHash !== reviewHash(canonical)) {
      throw new Error('INVALID_BAW_ATTEMPT: treat this authorization as attempted and reconcile it manually');
    }
  } else if (attempt.authorizationHash !== authorizationHash(state)) {
    throw new Error('INVALID_BAW_ATTEMPT: canonical state is unavailable and the attempt identity cannot be verified');
  }
  return { attemptedAt: attempt.attemptedAt ?? null, legacy: false, state: attempt.state, requestId: attempt.requestId };
}
function previewSummary(state) {
  return {
    state: state.file, phase: state.phase, requestId: state.requestId, expiresAt: new Date(state.expiresAt).toISOString(),
    authorizationId: state.authorizationId, chainId: 56, from: state.from, to: state.call.to, value: state.call.value,
    operation: state.operation, gasEstimate: state.gasEstimate,
    parsedTx: state.preview.parsedTx, simulationResult: state.preview.simulationResult,
    intent: state.intent, authorityChanges: state.preview.simulationResult.authorityChanges,
    tokenInfos: state.preview.tokenInfos,
    risks: state.preview.risks, requireConfirmation: state.preview.requireConfirmation,
    next: 'Show the transaction, simulation and all risks to the user; get explicit confirmation for this requestId before execute.',
  };
}

export async function previewBaw(opts, dependencies = {}) {
  const run = dependencies.run ?? runBaw, inspect = dependencies.inspect ?? inspectCommand;
  const verify = dependencies.verify ?? verifySubmission, now = dependencies.now ?? Date.now;
  const file = statePath(opts);
  return withFileLock(`${file}.lock`, async () => {
    const previous = await readPrivateJson(file, 'BAW state', null);
    if (previous) await readState(file);
    if (previous && previous.phase !== 'preview') throw new Error('BAW_ALREADY_ATTEMPTED: reconcile the existing request; do not submit again');
    const packetText = await requirePrivateFile(opts.packet, 'authorization packet');
    const inspected = await inspect(opts);
    if (inspected.chainId !== 56 || inspected.call.value !== '0') throw new Error('ONLY_BSC_ZERO_VALUE_AUTHORIZATION_SUPPORTED');
    if (!inspected.intent) throw new Error('LOCAL_INTENT_REQUIRED: use the packet and intent file produced together by prepare');
    await notAttempted(attemptPath(inspected, dependencies));
    const from = await walletAccess(run, opts.from, now);
    const { gasEstimate } = await verify(opts, from);
    const args = ['contract-call', 'preview', '--binanceChainId', '56', '--from', from,
      '--to', inspected.call.to, '--value', inspected.call.value, '--inputData', inspected.call.data];
    if (opts.gasLimit !== undefined) {
      if (!/^\d+$/.test(opts.gasLimit) || BigInt(opts.gasLimit) < 21_000n || BigInt(opts.gasLimit) > 15_000_000n
        || BigInt(opts.gasLimit) < BigInt(gasEstimate)) throw new Error('INVALID_BAW_GAS_LIMIT');
      args.push('--gasLimit', opts.gasLimit);
    }
    const preview = await run(args);
    validatePreview(preview);
    const expiresAt = expiry(preview.expiresAt);
    if (expiresAt <= now()) throw new Error('BAW_PREVIEW_EXPIRED');
    const state = { version: 1, file, phase: 'preview', chainId: 56, from,
      packet: resolve(opts.packet), packetHash: hash(packetText), authorizationId: inspected.id,
      call: inspected.call, configHash: fingerprint(inspected.config), operation: inspected.operation, intent: inspected.intent,
      requestId: preview.requestId, expiresAt, gasEstimate, preview };
    await save(file, state);
    return previewSummary(state);
  });
}

export async function executeBaw(opts, dependencies = {}) {
  if (!opts.state) throw new Error('BAW_STATE_REQUIRED');
  const run = dependencies.run ?? runBaw, inspect = dependencies.inspect ?? inspectCommand;
  const verify = dependencies.verify ?? verifySubmission, now = dependencies.now ?? Date.now;
  const saveState = dependencies.save ?? save;
  const file = statePath(opts);
  return withFileLock(`${file}.lock`, async () => {
    const state = await readState(file);
    if (state.phase !== 'preview') throw new Error('BAW_ALREADY_ATTEMPTED: check the existing request, never execute it again automatically');
    if (opts.confirm !== state.requestId) throw new Error('USER_CONFIRMATION_REQUIRED: pass the exact reviewed requestId');
    if (!Number.isFinite(state.expiresAt) || state.expiresAt <= now()) throw new Error('BAW_PREVIEW_EXPIRED');
    if (resolve(opts.packet) !== state.packet) throw new Error('AUTHORIZATION_FILE_CHANGED');
    const packetText = await requirePrivateFile(opts.packet, 'authorization packet');
    const inspected = await inspect(opts);
    if (hash(packetText) !== state.packetHash || inspected.id !== state.authorizationId || inspected.chainId !== 56
      || fingerprint(inspected.call) !== fingerprint(state.call) || fingerprint(inspected.config) !== state.configHash
      || !inspected.intent || fingerprint(inspected.intent) !== fingerprint(state.intent)) throw new Error('REVIEWED_AUTHORIZATION_CHANGED');
    const attempt = attemptPath(inspected, dependencies);
    await notAttempted(attempt);
    await walletAccess(run, state.from, now);
    await verify(opts, state.from);
    try {
      await writePrivate(attempt, `${JSON.stringify({ version: 1, state: file, requestId: state.requestId,
        authorizationId: state.authorizationId, authorizationHash: authorizationHash(state),
        reviewHash: reviewHash(state), attemptedAt: now() })}\n`, { exclusive: true });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('BAW_ALREADY_ATTEMPTED');
      throw error;
    }
    state.phase = 'executing'; state.attemptedAt = new Date(now()).toISOString();
    await saveState(file, state); // Freeze the attempt before asking BAW to sign or broadcast.
    let result;
    try { result = await run(['contract-call', 'execute', '--requestId', state.requestId]); }
    catch (error) { state.phase = 'unknown'; await save(file, state); throw error; }
    if (result?.status === 'BROADCASTED' && txHash(result.txHash)) {
      state.phase = 'broadcasted'; state.txHash = result.txHash;
    } else if (result?.status === 'PENDING_CONFIRMATION' && !result.txHash) {
      state.phase = 'pending_confirmation';
    } else {
      state.phase = 'unknown'; await save(file, state); throw new Error('BAW_UNKNOWN_EXECUTION_RESULT: inspect the App; do not resend');
    }
    state.orderId = typeof result.orderId === 'string' ? result.orderId : undefined;
    await save(file, state);
    return { state: file, phase: state.phase, requestId: state.requestId, orderId: state.orderId, txHash: state.txHash ?? null,
      next: state.phase === 'broadcasted' ? 'Broadcast is not confirmation; check transaction history and the chain receipt.' : 'Confirm in the Binance App; do not call execute again.' };
  });
}

export async function statusBaw(opts, dependencies = {}) {
  const run = dependencies.run ?? runBaw;
  const state = opts.state ? await readState(resolve(opts.state)) : null;
  const attempt = state ? await readAttempt(attemptPath(state, dependencies), state) : null;
  const transaction = opts.txHash ?? state?.txHash;
  if (transaction && !txHash(transaction)) throw new Error('INVALID_TRANSACTION_HASH');
  const observe = async args => {
    try { return { value: await run(args), error: null }; }
    catch (error) {
      const code = /^[A-Z][A-Z0-9_]*(?=:|$)/.exec(String(error?.message))?.[0] ?? 'BAW_STATUS_UNAVAILABLE';
      return { value: null, error: code };
    }
  };
  const [walletResult, lockResult, historyResult] = await Promise.all([
    observe(['wallet', 'status']),
    observe(['wallet', 'tx-lock', '--binanceChainId', '56']),
    transaction ? observe(['wallet', 'tx-history', '--binanceChainId', '56', '--tx', transaction]) : null,
  ]);
  let localLock = null;
  if (opts.state) {
    try {
      const info = await lstat(`${resolve(opts.state)}.lock`);
      let owner = null;
      try { owner = JSON.parse(await readFile(`${resolve(opts.state)}.lock`, 'utf8')); } catch {}
      const pid = Number(owner?.pid);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
      localLock = { present: true, modifiedAt: info.mtime.toISOString(), ...(owner ? { owner: { ...owner, alive } } : {}),
        note: 'A previous local operation may still be active or may have stopped unexpectedly. Do not remove the lock while another process is running.' };
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const phase = attempt && state?.phase === 'preview' ? 'unknown' : state?.phase ?? null;
  return { phase, recordedPhase: state?.phase ?? null, attempted: Boolean(attempt), attemptedAt: attempt?.attemptedAt ?? null,
    requestId: state?.requestId ?? null, txHash: transaction ?? null,
    attemptedState: attempt?.state ?? null, attemptedRequestId: attempt?.requestId ?? null,
    wallet: walletResult.value, lock: lockResult.value, history: historyResult?.value ?? null, localLock,
    diagnostics: { wallet: walletResult.error, lock: lockResult.error, history: historyResult?.error ?? null },
    note: transaction ? 'History is read-only; verify the receipt before claiming success.'
      : attempt ? 'A local attempt record exists. Treat the result as unknown until reconciled in the Binance App; never auto-resend.'
        : 'BAW documents no contract-call lookup by requestId. Resolve pending/unknown requests in the App; never auto-resend.' };
}
