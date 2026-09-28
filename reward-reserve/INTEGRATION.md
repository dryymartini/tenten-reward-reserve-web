# Integrating `/reward-reserve/` into tentencapital.net

The folder `reward-reserve/` is a self-contained static page. No build step, no framework —
wallet connection is plain EIP-1193 (`window.ethereum`), compatible with MetaMask and most
injected wallets, no SDK required.

## 1. Publish the page

1. Copy the folder to the site root so it is served at `https://tentencapital.net/reward-reserve/`
   (`index.html` + `assets/`). Do **not** copy `tests/` or this file.
2. All asset paths are relative. Absolute links used by the page: `/` (main site). Keep that route.
3. If the site sends a Content-Security-Policy, allow:
   - `connect-src https://rpc.mainnet.chain.robinhood.com https://robin.etherscan.io https://api.qrserver.com`
     (the QR code on the donations box; matches whatever `assets/rr-config.js` currently points at — see §2)
   - `img-src 'self' data: https://api.qrserver.com` (inline SVG favicon + donation QR code), `font-src 'self'`, `script-src 'self'`, `style-src 'self'`
4. Add a menu link to `/reward-reserve/` from the main site, if wanted.
5. `assets/tenten-base.css`, `tenten-logo.webp`, the cursors and fonts are copies of the main
   site's styling. If the main site already serves shared equivalents, the page can point at them
   instead; otherwise leave the copies as they are.

## 2. Switching from testnet to mainnet

Everything network- and contract-specific lives in `assets/rr-config.js`: `chainId`, `chainIdHex`,
`chainName`, `rpcUrl`, `explorer`, `nativeCurrency` and `addresses`. Updating those fields is the
only code change needed — nothing else in the page hardcodes an address or a chain id (the footer
badge and page copy read `network`/`chainName` from this same file).

Done 2026-09-28: the site now points at Robinhood Chain mainnet (`chainId` 4663). One field still
needs a real value once it's known: `deployBlock` (used only as the starting block for the Growth
section's event-log scan) is `null` until the mainnet deployment block is confirmed — until then
the Growth chart shows an honest "could not read the event log" rather than scanning the wrong
range or guessing.

## 3. Connecting the Indexer's epoch data

`assets/rr-config.js` → `epochsBaseUrl` is `null` until the Indexer has a public host. Once it
does, set it to the base URL that serves `epochs/<id>.json` (e.g.
`epochsBaseUrl: 'https://indexer.example.com/epochs'`) — the page fetches
`${epochsBaseUrl}/${id}.json` for each epoch from 1 to `latestEpochId()`.

The exact JSON schema (`epochId`, `snapshotTime`, `chainId`, `reserve`, `budget.committedTotal`,
`holders[addr].{balance,eligibleBalance,allocation,leaf,proof}`, `ineligible`, `tree.root`) is
validated in `assets/rr-providers.js` (`validEpoch`) before any value from it is shown; a bad or
unreachable file shows an explicit "not configured" / "failed validation" state, never fabricated
numbers.

**The JSON is never trusted for the claim itself.** Before an allocation is shown as claimable,
`rr-providers.js` re-checks it on chain: `claimedBy()` (already paid → shown as claimed) then
`verifyAllocation()` (the contract's own Merkle check on the exact amount + proof from the JSON).
Only then does the claim button send a transaction, and it always signs `claim(epochId, amount,
proof)` — the same three values just verified — never anything the JSON alone asserted.

## 4. Wallet / claim flow

- Connecting (`assets/rr-wallet.js`) only ever calls `eth_requestAccounts`, `eth_chainId`,
  `wallet_switchEthereumChain` / `wallet_addEthereumChain` (to get the user onto the configured
  Robinhood Chain network) and, on an explicit "Claim" click, `eth_sendTransaction` for
  `claim(...)`. It never calls `eth_sign` / `personal_sign` / `eth_signTypedData_*`, never requests
  or stores a private key, and never calls `approve()` on any token — `claim()` needs no allowance.
- `assets/rr-chain.js` is read-only: its RPC allow-list is `eth_call`, `eth_blockNumber`,
  `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_getLogs` only. It never sends a
  transaction; that is `rr-wallet.js`'s job alone, and only against the connected wallet's own
  provider.

## 5. Test locally

```sh
cd reward-reserve && python3 -m http.server 8080   # then open http://localhost:8080/
npm install && npm test                             # headless render + safety tests (from repo root)
```

Tests run against a fully synthetic mock RPC and a mock EIP-1193 wallet (no real network, no real
funds); they assert the claim flow never calls a signing method outside an explicit claim, never
calls `approve()`, and that an epoch already claimed on chain is never shown as claimable again.
