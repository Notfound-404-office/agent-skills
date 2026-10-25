// Only known local errors have public details. Provider errors may contain credentials or proofs.
const messages = {
  INVALID_COMMAND: 'Unknown command. Run protocol404 --help for supported commands.',
  PASSWORD_REQUIRED: 'Provision a local 0600 password file or unlock in a trusted terminal; never send passwords in chat.',
  PASSWORD_INPUT_CANCELLED: 'Password input was cancelled; no action was submitted.',
  PASSWORDS_DO_NOT_MATCH: 'The two local password entries did not match.',
  BAW_EXECUTABLE_NOT_FOUND: 'The baw executable is missing. Install the BAW CLI in this runtime before submission.',
  BAW_COMMAND_TIMEOUT: 'The BAW command timed out. Inspect baw status and the Binance App; do not repeat execution.',
  BAW_ALREADY_ATTEMPTED: 'This authorization was already attempted. Use baw status and reconcile in the Binance App; do not resend or delete attempt records.',
  BAW_STATE_REQUIRED: 'Provide --state with the saved BAW preview file.',
  BAW_PREVIEW_EXPIRED: 'The reviewed BAW preview expired. Stop; a new preview requires another review.',
  USER_CONFIRMATION_REQUIRED: 'Obtain explicit approval for this exact preview, then pass its requestId with --confirm.',
  BAW_BSC_NOT_CONNECTED: 'Connect BSC chain 56 in the Binance App.',
  BAW_BSC_ADDRESS_MISSING: 'BAW did not return an account for BSC chain 56.',
  BAW_FROM_NOT_OWNED: 'Select a BSC address owned by the connected BAW account with --from.',
  BAW_DEVELOPER_MODE_REQUIRED: 'Enable Developer Mode in the Binance App.',
  BAW_DEVELOPER_MODE_EXPIRED: 'Developer Mode expired. Check its settings in the Binance App.',
  BAW_WALLET_LOCKED: 'Resolve the pending wallet request in the Binance App before continuing.',
  BAW_UNKNOWN_EXECUTION_RESULT: 'The submission result is unknown. Inspect baw status and the Binance App; do not resend.',
  AUTHORIZATION_FILE_CHANGED: 'The packet path changed after review. Stop and inspect the intended packet.',
  REVIEWED_AUTHORIZATION_CHANGED: 'The packet, intent, or deployment changed after review. Stop; the old approval cannot be reused.',
  LOCAL_INTENT_REQUIRED: 'Use the packet and its matching .intent.json produced by prepare.',
  INVALID_BAW_TRANSACTION_VALUE: 'The authorization contains an invalid BSC transaction value.',
  ONLY_BSC_CHAIN_SUPPORTED: 'This adapter supports BSC chain 56 only.',
  INVALID_BAW_STATE: 'The saved BAW preview is inconsistent. Keep the files and reconcile the request; do not execute.',
  INVALID_BAW_ATTEMPT: 'The saved attempt record is inconsistent. Treat the outcome as unknown and reconcile; do not resend.',
  INVALID_BAW_GAS_LIMIT: 'The supplied gas limit is invalid or below the estimate. Review --gas-limit.',
  INVALID_TRANSACTION_HASH: 'Provide a 32-byte 0x-prefixed transaction hash.',
  BAW_INVALID_PREVIEW: 'BAW returned an incomplete preview. Stop without execution.',
  BAW_SIMULATION_FAILED: 'The BAW simulation failed. Review the transaction without executing it.',
  BAW_INVALID_EXPIRY: 'BAW returned an invalid preview expiry. Stop without execution.',
  BAW_INVALID_RESPONSE: 'BAW returned an unreadable response. Check status before any further submission.',
  BUDGET_EXCEEDED: 'The quoted principal plus buyer protocol fee exceeds --budget. Review the amount or budget.',
  MARKET_QUOTE_CHANGED: 'A selected order changed while quoting. Review a fresh quote before preparation.',
  QUOTE_STALE: 'A selected order changed while quoting. Review a fresh quote before preparation.',
  MARKET_V2_REQUIRED: 'Batch sweep quotes require a verified MarketV2 deployment.',
  NO_LIQUIDITY: 'No open listings can satisfy a valid fill. Review the market and requested amount.',
  INVALID_QUOTE: 'The selected fills do not satisfy the market integer, fee or dust constraints. Stop and review the quote.',
  MARKET_ORDER_BELOW_DUST: 'Both sides of a market order must be strictly above the deployed dust limits: 10 404 for token amounts and 0.0001 BNB for native amounts.',
  MARKET_ORDER_NOT_FOUND: 'The selected market order does not exist. Refresh orders and review the order id.',
  MARKET_ORDER_CLOSED: 'The selected market order is already closed. Refresh orders and choose an open order.',
  MARKET_ORDER_ASSET_MISMATCH: 'The supplied sell asset does not match the selected order. Review the order before filling it.',
  MARKET_FILL_BELOW_DUST: 'The fill payment is at or below the deployed dust limit. Increase the payment or choose another order.',
  MARKET_FILL_BAD_AMOUNT: 'The fill payment produces zero output. Increase the payment or review the order price.',
  MARKET_FILL_TOO_MUCH: 'The fill payment exceeds the order remainder. Refresh the order and review the amount.',
  MARKET_FILL_LEAVES_DUST: 'This fill would leave a remainder at or below the market dust limit. Fill the remaining order or choose a smaller valid amount.',
  MARKET_REVERT_BAD_AMOUNT: 'The market rejected the amount. Refresh the order and review payment, output and dust limits.',
  MARKET_REVERT_WRONG_PAYMENT: 'The market rejected the payment asset or fee total. Refresh the order and review the selected sell asset and fee.',
  MARKET_REVERT_BAD_ASSET: 'The market rejected the asset identifier. Refresh the order and use token or native as configured.',
  MARKET_REVERT_CLOSED: 'The market order closed before submission. Refresh orders and choose an open order.',
  MARKET_REVERT_WRONG_ORDER: 'The market order changed before submission. Refresh orders and prepare again.',
  MARKET_REVERT_LEAVES_DUST: 'The market rejected this fill because it would leave a dust remainder. Fill the remaining order or choose a smaller valid amount.',
  MARKET_REVERT_TOO_MUCH: 'The market rejected this fill because payment exceeds the current remainder. Refresh the order and prepare again.',
  VOID_ALREADY_PENDING: 'A cancellation is already pending or needs recovery. Inspect wallet history and baw status; do not create or submit another cancellation.',
  SDK_ROOT_NOT_FOUND: 'Run node scripts/setup.mjs from the actual installed skill directory to prepare the SDK automatically.',
  SDK_RELEASE_NOT_CONFIGURED: 'This release has no public SDK source yet. Use --root with a trusted local checkout, or wait for the maintainer to publish sdk-release.json.',
  SDK_RELEASE_INVALID: 'The SDK release metadata is invalid. Use --root with a trusted local checkout and report the release packaging error.',
  SDK_ROOT_INVALID: 'The explicit --root or PROTOCOL404_ROOT does not contain a compatible SDK. Correct the override, or remove it and run setup for automatic installation.',
  SDK_SETUP_INCOMPLETE: 'The selected SDK lacks its proof resource sources. Use a complete checkout, or remove the override and run setup for automatic installation.',
  SDK_ASSET_LAYOUT_INVALID: 'The proof manifest restores files to a different frontend directory. Use the standard SDK layout or align the custom manifest before setup.',
  SDK_CACHE_INVALID: 'The SDK cache is incomplete. Inspect that installation before repairing it; existing files are not overwritten automatically.',
  SDK_CACHE_OCCUPIED: 'Another setup created the SDK cache. Wait for it to finish, then run setup again.',
  SDK_BOOTSTRAP_FAILED: 'The fixed SDK release could not be downloaded. Check Git and network access, then run setup again.',
};

const result = (code, message = messages[code]) => ({ code, message });
const marketSelectors = Object.freeze({
  '0x749b5939': 'MARKET_REVERT_BAD_AMOUNT',
  '0x788a686f': 'MARKET_REVERT_WRONG_PAYMENT',
  '0x36405305': 'MARKET_REVERT_BAD_ASSET',
  '0x1cdde67b': 'MARKET_REVERT_CLOSED',
  '0x09686b32': 'MARKET_REVERT_WRONG_ORDER',
  '0x3a5f053c': 'MARKET_REVERT_LEAVES_DUST',
  '0xd887771b': 'MARKET_REVERT_TOO_MUCH',
});

export function publicError(error) {
  const raw = String(error?.message ?? '');
  const code = /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(raw)?.[0];
  if (Object.hasOwn(messages, code)) return result(code);
  if (/^BAW_(?:REJECTED|COMMAND_EXIT|COMMAND_SIGNALLED)_[A-Za-z0-9_-]{1,40}$/.test(code ?? '')) {
    return result(code, 'BAW stopped with this diagnostic code. Inspect baw status and the Binance App; do not automatically repeat execution.');
  }
  if (error?.code === 'ENOENT') return result('FILE_NOT_FOUND', 'A required local file or directory is missing. Check --root, --config, --wallet and supplied file paths.');
  if (['EACCES', 'EPERM'].includes(error?.code)) return result('FILE_ACCESS_DENIED', 'The runtime cannot access a required local file or directory. Check ownership and permissions.');
  if (error?.code === 'EEXIST') return result('FILE_ALREADY_EXISTS', 'The output already exists. Choose a new output path; existing files will not be overwritten.');
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return result('SDK_NOT_INSTALLED', 'An SDK dependency is missing. Run setup against the existing trusted SDK checkout.');
  if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') return result('NODE_FLAG_REQUIRED', 'This CLI imports TypeScript sources. Run ./scripts/404.mjs ... or node --experimental-strip-types scripts/404.mjs ...; plain node scripts/404.mjs is unsupported.');
  const selector = /0x[0-9a-f]{8}/i.exec(raw)?.[0]?.toLowerCase();
  if (selector && marketSelectors[selector]) return result(marketSelectors[selector]);
  if (String(error?.code).startsWith('ERR_PARSE_ARGS_')) return result('INVALID_ARGUMENT', 'A command option is unknown, missing a value, or in the wrong format. Run protocol404 --help.');
  const missing = /^missing (root|config|wallet|out|to|amount|asset|orderId|journalId|packet|state|confirm|mnemonicFile|fillsFile|budget|protocolFee|minBought)$/.exec(raw);
  if (missing) return result('MISSING_ARGUMENT', `Provide --${missing[1].replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} for this operation.`);
  if (raw === 'missing state or packet file') return result('MISSING_ARGUMENT', 'Provide --packet for a preview or --state for an existing BAW request.');
  if (raw === 'protocolFee is required and must be reviewed explicitly') return result('MISSING_ARGUMENT', 'Provide --protocol-fee from the reviewed quote; do not guess the fee.');
  if (/^(?:fills file must contain 1 to 20 entries|invalid fill at index \d+|duplicate orderId in fills file|(?:invalid )?fills\[\d+\]\.(?:orderId|pay)(?: exceeds uint256| must fit positive uint64)?)$/.test(raw)) {
    return result('INVALID_FILLS_FILE', 'The internal fills file has invalid or duplicate entries. Generate it with quote sweep; use 1–20 unique orders with positive integer payments.');
  }
  if (raw === 'state file must differ from the authorization packet') return result('INVALID_ARGUMENT', 'Use a separate --state file; it cannot overwrite the authorization packet.');
  if (/mode 0[67]00/.test(raw) && /^(?:private directory|wallet directory|password file|wallet vault|mnemonic file|authorization packet|packet intent sidecar|BAW state|BAW attempt record|transaction journal) (?:must be|must have)/.test(raw)) {
    return result('PRIVATE_FILE_PERMISSIONS', 'Use real directories with mode 0700 and regular files with mode 0600; symbolic links are not accepted.');
  }
  if (/^(?:wallet|output packet|output intent sidecar) already exists; refusing to overwrite it$/.test(raw)) return result('FILE_ALREADY_EXISTS', 'The wallet or output already exists. Choose a new path; existing data will not be overwritten.');
  if (raw.startsWith('another wallet operation is active; inspect the lock before retrying')) return result('LOCAL_OPERATION_LOCKED', 'A local operation holds the lock, or stopped unexpectedly. Inspect the reported pid/alive/startedAt metadata before recovery; do not remove an active lock while its owner is alive.');
  if (raw === 'insufficient spendable balance') return result('INSUFFICIENT_SPENDABLE_BALANCE', 'Unlocked, unreserved notes cannot cover this amount. Check balance.available, balance.max and pending history.');
  if (raw === 'needs more than two notes: consolidate first') return result('CONSOLIDATION_REQUIRED', 'This amount needs more than two notes. Prepare a merge first, then wait for its confirmed receipt.');
  if (raw === 'wrong password or damaged wallet file') return result('WALLET_UNLOCK_FAILED', 'The local password did not unlock this vault, or the vault is damaged. Check the local credential and backup without sharing them.');
  if (raw === '404 frontend SDK is not installed under frontend/') return result('SDK_NOT_INSTALLED', 'Set --root to the trusted SDK checkout and run setup.');
  if (raw.startsWith('BSC mainnet is not configured:')) return result('CONFIG_REQUIRED', 'Provide --config with a verified local BSC deployment configuration.');
  if (raw === 'only BSC mainnet chain 56 is supported' || raw === 'RPC chain ID does not match configuration') return result('CHAIN_MISMATCH', 'The configuration and RPC must both target BSC chain 56.');
  if (raw.startsWith('Market fee changed;')) return result('MARKET_FEE_CHANGED', 'The on-chain market fee differs from the reviewed quote. Review a fresh quote.');
  if (/^MARKET_(?:ORDER_NOT_FOUND|CLOSED|ASSET_MISMATCH|FILL_BELOW_DUST|FILL_BAD_AMOUNT|FILL_TOO_MUCH|FILL_LEAVES_DUST):/.test(raw)) {
    return result(code, messages[code]);
  }
  if (raw === 'unknown transaction journal entry') return result('JOURNAL_ENTRY_NOT_FOUND', 'Use the journalId returned by prepare or local wallet history, rather than the authorization id.');
  if (raw === 'the original request is already on chain; it cannot be voided') return result('ALREADY_CONFIRMED', 'The original transaction is already confirmed and cannot be voided.');
  if (raw === 'another transaction spent the original inputs; there is nothing to void') return result('INPUTS_ALREADY_SPENT', 'Another transaction already spent these inputs. Sync wallet history before continuing.');
  if (raw === 'this saved request has no private input that can be voided') return result('NO_VOIDABLE_INPUT', 'This request has no private input to invalidate with a conflicting spend. Review its actual operation and history.');
  if (/^(?:Invalid amount:|At most 8 decimal places$|Amount must be positive and fit a 64-bit note$|invalid (?:offset|limit|orderId|keyIndex|addressIndex|nonce|action|until|sellAmount|buyAmount|pay|minBought|protocolFee)$|asset must be token\/0 or native\/1$|limit must be positive$|wallet password must contain at least 8 characters$)/.test(raw)) {
    return result('INVALID_ARGUMENT', 'Check the amount, asset and numeric options. Human amounts must be positive with at most eight decimals; raw machine fields must fit their documented integer bounds.');
  }
  return result('OPERATION_FAILED', 'Operation failed. Keep local state and check configuration or wallet activity; nothing will be retried automatically.');
}
