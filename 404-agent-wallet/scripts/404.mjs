#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { doctor, walletCommand, readCommand, prepareCommand, inspectCommand } from './sdk.mjs';
import { previewBaw, executeBaw, statusBaw } from './baw.mjs';
import { hiddenPassword } from './password.mjs';
import { publicError } from './errors.mjs';
import { quoteSweep } from './quote.mjs';
import { resolveSdkRoot } from './runtime.mjs';

const help = `protocol404 — local ZK tools for tool-calling Bots; BAW submission on BSC 56

doctor                           Offline SDK/config/BAW executable checks
wallet create|import|address     Encrypted private wallet (never returns recovery words)
balance | orders | history       Read private balances, orders or wallet history
quote sweep                      Quote human token amount / optional BNB budget; write fills
prepare mint|send|withdraw|deposit|merge|place|fill|sweep|release|void
                                 Generate a fixed authorization packet, do not broadcast
inspect                          Inspect a packet without printing proof/calldata
baw preview                      Validate/simulate, then request BAW risk preview
baw execute                      Execute the exact user-confirmed preview once
baw status                       Read wallet lock/history; never resubmit

Common: --config PUBLIC_BSC_JSON; SDK is located automatically after setup
        Optional override: --root SDK_CHECKOUT (or PROTOCOL404_ROOT)
Wallet: --wallet DIR --password-file USER_PROVISIONED_0600_FILE
        --address-index N (0..255; default 0, derives pm/address/N)
        Without a secret file, an operator terminal can prompt with hidden input.
        Never put passwords or recovery words in chat or command arguments.
Prepare: --out FILE --asset token|native --amount DECIMAL --to ADDRESS
Market: --order-id N --sell-asset token|native --sell-amount RAW --buy-amount RAW
        --pay RAW --protocol-fee RAW --key-index N --nonce N --action 0|1 --until UNIX
Sweep: --fills-file FILE --min-bought RAW --protocol-fee RAW (1-20 MarketV2 orders)
Quote: --amount TOKEN_DECIMAL [--budget BNB_DECIMAL] --out FILLS_FILE
Void: --journal-id ORIGINAL_JOURNAL_ID --out NEW_CANCELLATION_PACKET
History: optional --offset N --limit N; omit both to return all recovered history
Packets: --packet FILE; BAW: --state FILE --from ADDRESS --gas-limit N
Execute: --confirm EXACT_REVIEWED_REQUEST_ID (explicit user consent is required)
Wallet import: --mnemonic-file USER_0600_FILE
Wallet create: optional --mnemonic-file OUTPUT (explicit plaintext recovery backup)

All results are JSON: {ok:true,data:...} or {ok:false,error:{code,message}}.
BSC deployment config is bundled at config/bsc-mainnet-404.json; pass it with --config. No MetaMask.
`;
const stringFlags = ['root','config','wallet','password-file','mnemonic-file','address-index','out','to','amount','asset','order-id','action','sell-asset','sell-amount','buy-amount','pay','protocol-fee','key-index','nonce','until','packet','state','from','gas-limit','confirm','tx-hash','fills-file','min-bought','offset','limit','journal-id','budget'];
const paths = ['root','config','wallet','passwordFile','mnemonicFile','out','packet','state','fillsFile'];
const camel = name => name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const inspectSummary = value => ({
  id: value.id, packet: value.packet, chainId: value.chainId, pool: value.pool,
  target: value.target, operation: value.operation, value: value.call.value,
  authorizationPath: value.authorizationPath, intent: value.intent, journalId: value.journalId,
  selector: value.call.data.slice(0, 10), calldataBytes: (value.call.data.length - 2) / 2,
  calldataSha256: createHash('sha256').update(value.call.data).digest('hex'),
});

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { ...Object.fromEntries(stringFlags.map(name => [name, { type: 'string' }])), help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const opts = Object.fromEntries(Object.entries(values).map(([key, value]) => [camel(key), value]));
  opts.root ??= process.env.PROTOCOL404_ROOT;
  for (const key of paths) if (opts[key]) opts[key] = resolve(opts[key]);
  let [command, subcommand, ...extra] = positionals;
  if (command === 'prepare' && subcommand === 'unshield') subcommand = 'withdraw'; // Accept the pre-404 command as input only.
  if (extra.length || (!['wallet','prepare','baw','quote'].includes(command) && subcommand)) throw new Error('INVALID_COMMAND');
  const subcommands = { wallet: ['create', 'import', 'address'], prepare: ['mint', 'send', 'withdraw', 'deposit', 'merge', 'place', 'fill', 'sweep', 'release', 'void'], baw: ['preview', 'execute', 'status'], quote: ['sweep'] };
  if (subcommands[command] ? !subcommands[command].includes(subcommand) : !['doctor', 'balance', 'orders', 'history', 'inspect'].includes(command)) throw new Error('INVALID_COMMAND');
  if (command === 'prepare' && subcommand === 'void' && !opts.journalId) throw new Error('missing journalId');
  if (command === 'prepare' && subcommand === 'fill' && opts.protocolFee === undefined) throw new Error('missing protocolFee');
  const requiredOptions = {
    wallet: ['wallet'], balance: ['config', 'wallet'], orders: ['config', 'wallet'], history: ['config', 'wallet'],
    prepare: ['config', 'wallet', 'out'], inspect: ['config', 'packet'], quote: ['config', 'amount', 'out'],
  };
  const needed = command === 'baw'
    ? { preview: ['config', 'packet'], execute: ['config', 'packet', 'state', 'confirm'], status: [] }[subcommand]
    : requiredOptions[command] ?? [];
  for (const key of needed) if (!opts[key]) throw new Error(`missing ${key}`);
  if (!(command === 'baw' && subcommand === 'status')) opts.root = await resolveSdkRoot(opts.root);
  const needsSecret = ['wallet', 'balance', 'orders', 'history', 'prepare'].includes(command);
  if (needsSecret && !opts.passwordFile) {
    opts.password = await hiddenPassword(command === 'wallet' && ['create','import'].includes(subcommand) ? 'Set wallet password: ' : 'Unlock wallet password: ');
    if (command === 'wallet' && ['create','import'].includes(subcommand)) {
      const again = await hiddenPassword('Confirm wallet password: ');
      if (again !== opts.password) throw new Error('PASSWORDS_DO_NOT_MATCH');
    }
  }
  let result;
  try {
    if (command === 'doctor') {
      result = await doctor(opts);
      try { await promisify(execFile)('baw', ['--version'], { timeout: 10_000, maxBuffer: 32_768 }); result.bawInstalled = true; }
      catch { result.bawInstalled = false; }
      result.nodeVersion = process.versions.node;
      result.mode = 'offline'; result.authChecked = false;
    } else if (command === 'wallet') result = await walletCommand(subcommand, opts);
    else if (command === 'quote') result = await quoteSweep(opts);
    else if (['balance', 'orders', 'history'].includes(command)) result = await readCommand(command, opts);
    else if (command === 'prepare') result = await prepareCommand(subcommand, opts);
    else if (command === 'inspect') result = inspectSummary(await inspectCommand(opts));
    else if (command === 'baw' && subcommand === 'preview') result = await previewBaw(opts);
    else if (command === 'baw' && subcommand === 'execute') result = await executeBaw(opts);
    else if (command === 'baw' && subcommand === 'status') result = await statusBaw(opts);
    else throw new Error('INVALID_COMMAND');
  } finally { delete opts.password; }
  process.stdout.write(`${json({ ok: true, data: result })}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stdout.write(`${json({ ok: false, error: publicError(error) })}\n`); process.exitCode = 1;
});
