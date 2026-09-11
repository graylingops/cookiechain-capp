# Cookie Jar — a cApp on Cookie Chain

Cookie Jar is a tiny, single-purpose web app where **every action is a real Cookie
Chain transaction**: an SPL Memo instruction signed by your wallet, confirmed
on-chain with live feedback, and rendered into a shared feed and activity
dashboard read directly from the Cookie Chain RPC.

No custom program, no token transfers, no accounts, no tracking, nothing stored
server-side. Your keys never leave your wallet. The only cost of using it is the
transaction fee, paid in COOK.

What sets it apart from other memo-guestbook apps on Cookie Chain:

- **Wrong-network guard** — the app checks the chain's genesis hash on load and
  refuses to sign against anything but Cookie Chain;
- **free simulate-first** — every transaction can be dry-run on the live RPC with
  no fee and no signature before anything is signed;
- **a real dashboard** — activity feed, stat tiles and a last-24h cookies-per-hour
  chart, all read straight from chain state;
- **two key-free verification tools** — a $0 dry-run builder (`tools/dryrun_memo.py`)
  and an independent tx verifier (`tools/verify_tx.py`), both strict stdlib, no keys;
- **an open participants list** — anyone can get their jar tracked by opening a PR
  that adds an address (never a key) to `participants.json`.

Open source (MIT). Built for the "Create an App on Cookie Chain" bounty.

## Status: staging (honest read)

This repository is the **staging state** of the bounty entry, pushed as the
work-in-progress pre-build. It is **not an official Cookie Chain project**:
Cookie Jar is an independent bounty entry, and no affiliation with, or
endorsement by, Cookie Chain, its team, Nightly, or the SPL program
maintainers is claimed or implied. Everything here is subject to change
before the bounty submission.

Concrete status:

- built and verified against the live Cookie Chain RPC (genesis-checked);
- **only the operator demo wallet is gas-gated** — see "Current deployment
  status" below;
- the bounty entry itself has **not yet been submitted**.

## Quick start

1. Install **Nightly** from <https://nightly.app> (the Cookie Chain brief
   requires Nightly; other standard SVM wallets work too).
2. In Nightly's network settings, add a custom SVM network with the RPC URL
   below and select it.
3. Fund the wallet with a little COOK for fees:
   - bridge from Solana via the community bridge <https://hyperlane.cookiescan.io>, or
   - ask the Cookie Chain team (there is no faucet).
4. Open the app, connect, type a cookie note, **Simulate** (free) to see the
   instruction execute without any fee, then **Sign & send** and watch the
   confirmation go processed → confirmed → finalized.

## Network details

| | |
|---|---|
| Chain | Cookie Chain (SVM, solana-core 4.1.2 at build time) |
| RPC | `https://rpc.cookiescan.io` |
| WebSocket | `wss://wss.cookiescan.io` |
| Genesis hash | `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2` |
| Explorer | <https://cookiescan.io> |
| Tx fee | 5,000–10,000 lamports observed on-chain at build time, paid in COOK |

The app checks `getGenesisHash` on load and shows a blocking warning if the RPC
answers with a different genesis, so you can never sign on the wrong chain by
accident.

## Program used

SPL Memo v2: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` — already deployed and
executable on Cookie Chain (verified live via `getAccountInfo`). That is why
Cookie Jar needs no program deploy and no deploy cost: the only on-chain expense
is the per-transaction fee.

Memo payload schema:

```
cookiejar:v1|<kind>|<note>      kind ∈ { bake, taste, tip }
```

The v2 instruction index byte (`0x00`) prefixes the payload inside the
instruction data; the tag prefix lets the feed pick jar memos out of all chain
activity.

## App-specific data / dashboard

The feed and dashboard are read-only RPC views over real chain state:

- feed — recent `cookiejar:v1` memos from the wallets in
  [`participants.json`](participants.json) plus your connected wallet, each with
  a cookiescan.io transaction link;
- stat tiles — jar memos seen, distinct bakers, last-24h count, latest slot;
- chart — memos per hour over the last 24 hours (single series, block time from
  the RPC), with a table view for accessibility.

To have your jar tracked publicly, open a PR adding your **address** (never a
key) to `participants.json`.

## Tools (server-side, read-only, $0)

- `tools/dryrun_memo.py` — builds a complete memo transaction in memory with a
  throwaway keypair generated from `os.urandom` (never persisted, never printed,
  unfunded), verifies the ed25519 signature locally (pure-python RFC 8032), and
  runs the instruction through `simulateTransaction` against the live chain.
  Proves construction + signature + program execution with **zero gas**:

  ```
  python3 tools/dryrun_memo.py            # against the default RPC
  python3 tools/dryrun_memo.py <rpc-url> "your note"
  ```

- `tools/verify_tx.py <signature>` — independent, key-free verification that a
  transaction exists on Cookie Chain, succeeded, and carries a valid
  `cookiejar:v1` memo. Useful to audit any tx posted in the demo thread:

  ```
  python3 tools/verify_tx.py <signature>        # human-readable report
  python3 tools/verify_tx.py <signature> --json # machine-readable
  ```

Both are strict stdlib Python 3 — no dependencies, no keys, no spend.

## Running locally

Everything is static — no build step, no bundler, no npm:

```
python3 -m http.server 8080 --directory .   # then open http://localhost:8080
```

`@solana/web3.js` and `bs58` load as ES modules from esm.sh at runtime. Wallet
interaction happens entirely in your browser between your wallet and the chain;
this page talks to the RPC for reads and to your wallet for signing.

## Current deployment status (gas gate)

The `Sign & send` button is **gated for this deployment's operator demo wallet
only**: Cookie Chain has no faucet, and the only $0 route to fee money is a
sponsor COOK drip, which is pending. Every other user with a funded wallet can
transact normally right now — the same code path, same confirmation handling,
same feed. Everything else — wallet connect, address display, transaction
construction, free on-chain simulation, confirmation handling, error feedback,
feed, dashboard — is live for everyone. This gate is documented in the app UI
and in the repository; it is a deployment-stage constraint, not a missing
feature.

## License

MIT.