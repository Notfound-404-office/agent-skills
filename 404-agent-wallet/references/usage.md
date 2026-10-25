# 404 Agent Wallet usage

The skill drives the repository's existing 404 SDK and real Node ZK prover. It prepares user-bound authorization packets locally, then optionally hands the encoded call to Binance Agentic Wallet (BAW) through BAW's official preview/execute flow.

## Requirements and installation

- Node.js 22.20 or newer, npm and Python 3. Git is only needed when selecting a custom SDK checkout with `--root`.
- A tool-enabled Agent with local filesystem and process access, on macOS, Linux or Windows through WSL. Native Windows wallet-file permissions have not been implemented.
- A local BSC deployment config before balance, order, prepare, inspect, or BAW commands can run.

After publishing, replace `ORG/REPOSITORY` with the public release repository and select the Agent you use in the installer:

```bash
npx skills add https://github.com/ORG/REPOSITORY/tree/main/skills/404-agent-wallet --skill 404-agent-wallet
```

The installer supports project and user installation scopes; see the [official skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#source-formats). This skill does not assume any Agent's hidden installation directory.

Install the Binance skill separately when BAW submission is needed. Do not install it merely for offline 404 wallet work:

```bash
npx skills add binance/binance-skills-hub --skill binance-agentic-wallet
```

Run setup from the installed skill's own directory:

```bash
node scripts/setup.mjs
node --experimental-strip-types scripts/404.mjs doctor
```

**For the Agent:** resolve this directory from the actual loaded `SKILL.md` path supplied by your host. All `scripts/...` paths in this guide are relative to that directory, as defined by the [Agent Skills file-reference convention](https://agentskills.io/specification#file-references). Use it as the command working directory, or run the resolved absolute script path. Do not guess a hidden folder or ask the user to configure `SKILL_DIR`.

`setup.mjs` uses the bundled SDK, circuit sources, generated artifacts and proof assets, then installs the locked frontend and relayer dependencies and runs proof-resource restore with SHA-256 validation. The relayer package is required locally because the portable transaction parser shares its validators. Setup does not start the relayer service. Subsequent commands locate that bundled SDK automatically. Setup does not create a wallet, deploy contracts or configure BSC.

The bundled SDK is the primary release path. A public `sdk-release.json` may still be supplied as a fallback for packages that intentionally omit the bundle; it is not required for this self-contained skill.

An existing custom checkout remains optional:

```bash
node scripts/setup.mjs --root /path/to/existing/404-checkout
```

Use `--root` or `PROTOCOL404_ROOT` only to select a trusted custom checkout. An invalid or empty explicit path stops instead of silently selecting another SDK. Custom layouts must restore proof resources into the selected frontend's public directory; setup rejects a mismatched manifest before installing dependencies. There is no need to fill an SDK path for the normal install.

Optionally install the local wrapper as a global command from this same skill directory:

```bash
npm install -g .
protocol404 doctor
```

The bundled Node entrypoint works without global installation. In command references, `protocol404` is shorthand for that entrypoint or the optional global command.

## Output and files

- Commands return JSON for normal results, state, and errors.
- `--json` may appear anywhere; the CLI returns JSON even when it is omitted.
- `doctor` is offline. It checks the SDK/config shape and whether the `baw` executable is present; it does not authenticate BAW, contact RPC, or validate all proof assets. Without `--config`, `configured: false` and `status: "not configured"` is expected until a BSC deployment exists.
- Wallet directories must be `0700`. Vaults, mnemonic files, authorization packets, BAW state, journals, locks, and password files must be `0600`.
- Standard output must not contain a seed, mnemonic, password, witness, or complete proof.
- An authorization packet is a bearer authorization even though it does not contain the mnemonic. Keep it private and do not paste it into chat.
- `prepare` also writes a private `<packet>.intent.json` containing the packet hash, human-readable intent and `journalId`. Keep it with the packet. `inspect` checks this binding before showing the intent; its `id` identifies the authorization, not the journal entry.
- BAW submission requires that intent file. External packets without it can be inspected only at the authorization-path level, not submitted through this adapter.
- The adapter records attempted calls under `~/.local/state/protocol404/baw-attempts/`. Do not delete these records or change state files to retry pending or unknown transactions; they prevent duplicate attempts within this runtime.
- Local input, missing-file, permission, insufficient-balance and BAW process failures return distinct safe error codes and recovery guidance. Unknown provider errors remain redacted; raw RPC errors, subprocess output and stacks are not printed.

## Password and recovery rules

The local process creates a 32-byte 404 seed. The project's existing 24-word format can recover it. The vault stores only the project's scrypt + ChaCha20-Poly1305 encrypted JSON format and remains compatible with the web wallet.

The primary operating model is a tool-enabled App conversation backed by a controlled runtime that can run Node and access private local files. The user provisions the password in the platform's Secret manager or another approved local secret channel; the runtime exposes it only as a `0600` file and passes its path with `--password-file`. Never put the password value itself in a shell argument, environment variable, prompt, log, or chat message.

Example for a controlled bot runtime after the user or platform has safely provisioned the file:

```bash
protocol404 wallet address --wallet "$HOME/.local/share/protocol404/wallet" \
  --password-file "/private/path/password"
```

Do not create, inspect, or print that file for the user. Stop if it is absent or has the wrong permissions.

A local TTY is an optional initialization or maintenance path. Omit `--password-file` and answer the hidden local prompts; wallet creation and import request the password twice.

`wallet create` does not emit a mnemonic by default. Only when the user explicitly requests an offline backup, add `--mnemonic-file FILE`; the CLI creates it with mode `0600`. Move it to offline storage. `wallet import` reads a user-provided `0600` local mnemonic file; an agent must not read or display it.

## Tool-enabled bots and chat-only apps

No TTY does not mean no tools. The supported bot path is the controlled background runtime described above. The secret stays on the user's machine or approved runtime; the user must not send it to the bot conversation or a project server.

A pure chat app does not gain local filesystem, process, SDK, BAW, or transaction permissions merely because this skill is installed. If the runtime has no TTY and no safely pre-provisioned credential, stop wallet creation, import, unlock, and proof preparation. Report the missing local capability rather than claiming success.

AI Mint has no chat-only or manual-web substitute in this skill: without the controlled runtime and a safe credential, state that AI Mint cannot run and stop. For later send, withdraw, or market actions, the user may independently use the existing website or the Agent. An agent-intent page, authorization deep link, and one-tap web/App flow are not implemented in this release.

## Command reference

Use either `protocol404` or:

```text
node --experimental-strip-types scripts/404.mjs
```

SDK discovery is automatic after setup. `--root DIR` takes priority over `PROTOCOL404_ROOT`; both are optional overrides.

### Offline health check

```text
protocol404 doctor [--config FILE]
```

Checks the local runtime, SDK, optional public config, and availability of the `baw` executable without an RPC request or BAW login. It does not replace proof-asset validation performed by setup/proving. No default BSC deployment address exists.

### Encrypted wallet

```text
protocol404 wallet create  --wallet DIR [--address-index N] [--mnemonic-file FILE] [--password-file FILE]
protocol404 wallet import  --wallet DIR --mnemonic-file FILE [--address-index N] [--password-file FILE]
protocol404 wallet address --wallet DIR [--address-index N] [--password-file FILE]
```

- `create` generates the seed locally and refuses to overwrite a wallet.
- `import` restores the seed from a private local 24-word file.
- `address` prints the derived public `4041...` address and its `addressIndex`; `N` must be `0..255` and defaults to `0`.

### Read state

```text
protocol404 balance --config FILE --wallet DIR [--password-file FILE]
protocol404 orders  --config FILE --wallet DIR [--password-file FILE]
protocol404 history --config FILE --wallet DIR [--password-file FILE] [--offset N --limit N]
```

These commands read BSC state and decrypt only the local vault needed for the request.

`balance` returns raw eight-decimal note units for each asset. `total` is the on-chain unspent total; `available` excludes both time-locked notes and unresolved local reservations. `max` is the largest single amount spendable with at most two available notes, capped at uint64; it is not the total spendable balance. `reserved` and `locked` are disjoint: a reserved note is counted as reserved even when time-locked. The corresponding `notes`, `availableNotes`, `reservedNotes` and `lockedNotes` give note counts. The Agent converts these machine fields to ordinary decimal amounts for the user.

`history` first synchronizes from the configured deployment block through one fixed, verified chain head. Without pagination it returns the complete recovered wallet history; `--offset` and `--limit` only page the completed result and do not impose a 50-row chain scan. Its result includes the history scope, total count, `nextOffset`, recovered on-chain rows, and any local records that have not reached the chain.

Recovery follows this wallet's `NoteAdded` and `Nullified` activity and scans maker key indexes `0..9999`, so it can recover passive fills of the wallet's orders after a seed is imported on another device. This is not a full-pool or BAW Gas-wallet transaction feed. Without the previous device's local journal, on-chain note existence, note receipts/spends, and the wallet's order events remain recoverable, but an old private recipient or exact `send`/`merge` intent that was never public cannot be reconstructed; report its operation as `unknown`. History never prints a seed, proof, or nullifier. `noteFlow.token` and `noteFlow.native` contain raw `received`, `spent`, and `net` values; these include change notes and therefore are not the same as a transfer amount. `total` counts recovered on-chain transactions; unmatched local journal records are returned separately in `local`.

### Prepare a ZK authorization packet

Every prepare command requires `--config FILE --wallet DIR --out FILE` and optional `--password-file FILE`. The output file must not already exist. Preparing generates the necessary ZK proof or market signature locally but never broadcasts a transaction.

```text
protocol404 prepare mint     --config FILE --wallet DIR --out FILE
protocol404 prepare send     --config FILE --wallet DIR --out FILE --to 404_ADDRESS --amount AMOUNT --asset token|native
protocol404 prepare withdraw --config FILE --wallet DIR --out FILE --to EVM_ADDRESS --amount AMOUNT --asset token|native
protocol404 prepare deposit --config FILE --wallet DIR --out FILE --amount AMOUNT --asset token|native
protocol404 prepare merge    --config FILE --wallet DIR --out FILE --asset token|native
protocol404 prepare place    --config FILE --wallet DIR --out FILE --sell-asset token|native --sell-amount RAW --buy-amount RAW [--key-index N]
protocol404 prepare fill     --config FILE --wallet DIR --out FILE --order-id RAW --sell-asset token|native --pay RAW --protocol-fee RAW
protocol404 prepare sweep    --config FILE --wallet DIR --out FILE --fills-file FILE --min-bought RAW --protocol-fee RAW
protocol404 prepare release  --config FILE --wallet DIR --out FILE --order-id RAW --action 0|1 --asset token|native --key-index N --nonce N [--until RAW]
protocol404 prepare void     --config FILE --wallet DIR --out NEW_FILE --journal-id ORIGINAL_JOURNAL_ID
```

`--amount` accepts a human-readable integer or a decimal with at most eight fractional digits. Market fields `--sell-amount`, `--buy-amount`, `--pay`, `--min-bought`, and `--protocol-fee` are machine-level raw note units. In `prepare fill`, `--sell-asset` is the asset sold by the order, not the payment asset; the CLI rereads the selected order and rejects an asset mismatch before proving. The Agent handles exact eight-decimal conversion with BigInt and verified protocol data; the user supplies ordinary quantities and budgets. For batch purchases, use `quote sweep` below to generate these machine fields automatically. Never guess prices or fees, or ask the user to write raw-unit JSON.

`prepare deposit` creates a Pool `shield` authorization for the local private address. A native deposit carries `amount × 10^10` wei as the packet value; a token deposit carries zero native value and requires the BAW wallet to have approved the Pool to spend the token.

For `prepare place`, both sides of a MarketV2 order must be strictly above dust. A token amount must be greater than `1_000_000_000` raw units (10 404), and a native amount must be greater than `10_000` note units (0.0001 BNB). The CLI also rejects a ratio where paying `buyAmount - 1` would leave a nonzero sell-side residual at or below dust; such an order can become impossible to close after a partial fill. Adjust the raw amounts or price before preparing. These checks run before unlocking and proving.

### Market maker asset warning

This risk applies only when the maker uses a contract-controlled wallet that cannot later produce the required ECDSA signature. Ordinary EOA makers are not affected. Market cancellation and maker asset release currently accept ECDSA signatures only; ERC-1271 contract signatures and other contract authorization paths are unsupported, so the maker's assets can otherwise become permanently locked.

`prepare sweep` targets MarketV2 and accepts at most 20 fills. The generated `--fills-file` contains a JSON array in this shape; it is an internal adapter format, not user input. `orderId` and `pay` are raw integer strings:

```json
[
  { "orderId": "101", "pay": "250000000" },
  { "orderId": "108", "pay": "175000000" }
]
```

The fills file is not a wallet secret, but it records the user's intended orders and amounts; keep it in a controlled local file. The CLI validates the MarketV2 deployment and its on-chain fee, generates the ZK authorization, and saves the packet and bound intent. It does not broadcast. Inspect the packet, then use the normal BAW preview, exact request-ID confirmation, and one-time execute flow. There are no Swap, add-liquidity, or remove-liquidity commands in this release.

Mint is fixed at one lot per packet. The submitting BAW address must hold the membership NFT and has a cumulative limit of ten mints for this pool.

### Quote a purchase from ordinary amounts

```text
protocol404 quote sweep --config FILE --amount TOKEN_DECIMAL [--budget BNB_DECIMAL] --out FILLS_FILE
```

This public, read-only command requires no wallet unlock and generates no proof. It reads actual open listings, the deployed MarketV2 fee and token dust threshold, quotes up to twenty cheapest listings using the SDK's integer math, then rereads the selected orders before saving a private, non-overwriting fills file.

For example, a user can ask “buy 1,000 404, spending no more than 0.1 BNB.” The Agent supplies `--amount 1000 --budget 0.1`; the user does not supply raw units or JSON. `--budget` includes principal plus the buyer's protocol fee, and excludes BAW Gas. A quote over budget stops with `BUDGET_EXCEEDED` without writing a file.

The result includes ordinary decimal `display` strings for `requested`, `actual`, `principal`, `protocolFee` and `total`, plus `complete`, `feeBps` and `orderCount`. Show these to the user. Integer rounding, available liquidity or dust rules can change the actual amount; do not claim the requested quantity is guaranteed. Any difference needs review of the actual terms. The returned `prepare.fillsFile`, `prepare.minBought` and `prepare.protocolFee` feed `prepare sweep` automatically inside the Agent. `minBought` equals the actual quote; no unrequested slippage is added.

The quote neither reserves funds nor authorizes a purchase. After preparation, inspect and obtain explicit approval for the exact BAW preview. Orders can change later; the BAW simulation and contract still enforce the encoded fills and minimum purchase. Do not silently replace failed fills or increase the budget.

### Cancel or change a prepared payment

Use the original `journalId` returned by `prepare`, `inspect`, or local wallet history, rather than the authorization `id`:

```text
protocol404 prepare void --config FILE --wallet DIR --journal-id ORIGINAL_JOURNAL_ID --out NEW_PACKET
```

An exported packet remains a valid bearer authorization even if its file is deleted. The CLI reuses the SDK's `void()` to prepare a transaction that spends one of the original inputs back to this wallet. Inspect that new packet, preview it, obtain exact confirmation and submit it through BAW. Only the confirmed conflicting spend invalidates the old packet; preparing the cancellation alone does not free funds. If the original transaction wins the race, the cancellation cannot reverse it.

Repeating `prepare void` for an already exported cancellation recovers its saved packet to a new output path. It does not create another cancellation or automatically submit. An already pending cancellation must be reconciled through history and BAW status. A locally `prepared` record that was never exported can be discarded by the SDK; the result is `exported: false`, `packet: null`, `status: "discarded"`, and there is no BAW step. Requests with no private input, such as an order release signature, cannot use this conflicting-spend mechanism.

Never delete the journal, original packet, or BAW attempt records to claim a cancellation or bypass reservations. After a confirmed cancellation, run `balance` or `history` to reconcile the original and update spendable funds.

### Inspect a packet

```text
protocol404 inspect --config FILE --packet FILE
```

Inspection reparses the packet against the selected config and returns its bound target, value, chain, pool, authorization path, saved intent (if available), function selector, calldata byte length, and calldata SHA-256 digest. The intent is trusted local preparation metadata, not independently decrypted from the proof. It does not broadcast or print the full calldata/proof.

### BAW preview, execution, and observation

```text
protocol404 baw preview --config FILE --packet FILE [--from ADDRESS] [--state FILE] [--gas-limit N]
protocol404 baw execute --config FILE --packet FILE --state FILE --confirm REQUEST_ID
protocol404 baw status [--state FILE] [--tx-hash HASH]
```

BAW must be configured in the Binance App with Developer Mode enabled. If `baw wallet settings --json` does not report `data.devMode.enabled: true`, stop and tell the user to enable it in the App.

The adapter is restricted to BSC chain ID `56`. It preserves the exact transaction value encoded in the authorization packet, including a nonzero value when the authorized contract call requires it. Preview validates the packet again, checks NFT eligibility for mint, estimates the call locally, then invokes the official shape:

```text
baw contract-call preview --binanceChainId 56 --from ... --to ... --value ... --inputData ... --json
```

It passes the official `--gasLimit 10000000` by default so large proof calls do not fail on BAW's lower default. You can override it with `--gas-limit N`; the value must still cover the local estimate. Preview saves its bearer request state to a private file and does not execute.

Before execution, show the user:

- the inspected 404 operation, chain, target, value, and packet identity;
- BAW `parsedTx` and `simulationResult`;
- all transaction/address `risks`;
- all `authorityChanges`; and
- the preview `requestId`, expiry, and whether Binance App confirmation may also be required.

Obtain explicit approval for that exact preview. `requireConfirmation=false` only describes Binance App behavior; it does not authorize the agent to execute. The adapter requires the matching request ID again through `--confirm` and calls only:

```text
baw contract-call execute --requestId REQUEST_ID --json
```

Stop on preview failure, intercepted risk, expiry, execute failure, or rejection. Do not bypass, automatically repeat, or substitute another packet. `PENDING_CONFIRMATION` means the user must act in the Binance App. For an unknown outcome, observe only: use `protocol404 baw status`, `baw wallet tx-history --binanceChainId 56 --tx HASH --json` when a hash is known, or an on-chain receipt. With no hash, observe the Binance App or `baw wallet tx-lock --binanceChainId 56 --json`; a wallet lock is not transaction status. BAW has no `contract-call status` or `contract-call result` command.

`baw status --state FILE` reconciles the saved preview with the private attempt marker before reporting its phase. If execution stopped after writing the marker but before updating the preview state, it reports `phase: "unknown"`, `recordedPhase: "preview"` and `attempted: true`. Local attempt evidence remains available when BAW is missing or offline; `diagnostics` classifies observation failures without exposing subprocess output. This is evidence of an attempted operation, not proof of broadcast or confirmation.

`localLock` reports a residual local lock without acquiring or removing it. An operator or Agent may inspect active local processes to establish whether an operation is still running. Remove only a proven stale lock after that process has stopped; never remove attempt or journal records, and never turn this maintenance step into permission to resend.

Official pinned contract: [Binance Agentic Wallet external signing](https://github.com/binance/binance-skills-hub/blob/f42217160b1278f18e4df3fbe5b7816f00ad4009/skills/binance-web3/binance-agentic-wallet/references/external-sign.md).

## Copyable examples

Run these commands from the actual installed skill directory. Replace wallet, credential and public-config paths with files provided by the runtime. None of these examples supplies or implies a deployed BSC address.

### 1. Initialize and run the offline doctor

```bash
node scripts/setup.mjs
node --experimental-strip-types scripts/404.mjs doctor
```

Until a real BSC config is provided, the doctor should report `not configured` rather than guessing an address.

### 2. Create an encrypted wallet in the controlled bot runtime

```bash
export PROTOCOL404_PASSWORD_FILE="/run/secrets/protocol404-password"
node --experimental-strip-types scripts/404.mjs wallet create --wallet "$HOME/.local/share/protocol404/wallet" \
  --password-file "$PROTOCOL404_PASSWORD_FILE"
```

The user or platform must provision the password file securely with mode `0600`; the bot must not create it from chat text. For optional local TTY initialization, omit `--password-file` and use the hidden prompts. If the user explicitly requested a 24-word offline backup:

```bash
node --experimental-strip-types scripts/404.mjs wallet create \
  --wallet "$HOME/.local/share/protocol404/wallet-with-backup" \
  --password-file "$PROTOCOL404_PASSWORD_FILE" \
  --mnemonic-file "/private/offline/path/404-recovery.txt"
```

The backup is created as `0600`; move it offline and never print it.

### 3. Prepare and inspect a private send without broadcasting

```bash
export CONFIG="/private/config/404-bsc-mainnet.json"
export WALLET="$HOME/.local/share/protocol404/wallet"
export PROTOCOL404_PASSWORD_FILE="/run/secrets/protocol404-password"
export RECIPIENT_404="4041...replace-with-user-recipient"
export PACKET="$HOME/.local/share/protocol404/send.packet.json"

node --experimental-strip-types scripts/404.mjs prepare send --config "$CONFIG" --wallet "$WALLET" \
  --password-file "$PROTOCOL404_PASSWORD_FILE" --to "$RECIPIENT_404" \
  --amount "1.25000000" --asset token --out "$PACKET"
node --experimental-strip-types scripts/404.mjs inspect --config "$CONFIG" --packet "$PACKET"
```

Stop after inspection unless the user asks to submit this exact packet.

### 4. Preview with BAW, then wait for exact confirmation

```bash
export CONFIG="/private/config/404-bsc-mainnet.json"
export PACKET="$HOME/.local/share/protocol404/send.packet.json"
export BAW_STATE="$HOME/.local/share/protocol404/baw-preview.json"
export BAW_ADDRESS="replace-with-user-baw-address"

node --experimental-strip-types scripts/404.mjs baw preview --config "$CONFIG" --packet "$PACKET" \
  --from "$BAW_ADDRESS" --state "$BAW_STATE"
```

Show the returned parsed transaction, simulation, risks, and authority changes. Only after the user explicitly confirms that exact preview, copy its real request ID locally and run:

```bash
export REQUEST_ID="replace-with-confirmed-preview-request-id"
node --experimental-strip-types scripts/404.mjs baw execute --config "$CONFIG" --packet "$PACKET" \
  --state "$BAW_STATE" --confirm "$REQUEST_ID"
```

Do not combine preview and execute into an unattended script.
