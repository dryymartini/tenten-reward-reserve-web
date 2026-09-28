# Integrating `/reward-reserve/` into tentencapital.net

The folder `reward-reserve/` is a self-contained static page. No build step, no framework,
no wallet library, no server code.

## 1. Publish the page

1. Copy the folder to the site root so it is served at `https://tentencapital.net/reward-reserve/`
   (`index.html` + `assets/`). Do **not** copy `tests/` or this file.
2. All asset paths are relative. Absolute links used by the page: `/` (main site) and `/reserve/`
   (Permanent Reserve). Keep those routes.
3. If the site sends a Content-Security-Policy, allow:
   - `connect-src https://rpc.mainnet.chain.robinhood.com https://robinhoodchain.blockscout.com`
   - `img-src 'self' data:` (inline SVG favicon), `font-src 'self'`, `script-src 'self'`, `style-src 'self'`
4. Add a menu link to `/reward-reserve/` from the main site and from `/reserve/`, if wanted.
5. `assets/tenten-base.css`, `tenten-logo.webp`, the cursors and fonts are copies of the
   `/reserve/` styling. If the main site already serves shared equivalents, the page can point at
   them instead; otherwise leave the copies as they are.

## 2. What is live today (no configuration)

Everything in `assets/rr-config.js` → `addresses` is read directly from Robinhood Chain (id 4663)
through the public RPC, all values of one refresh pinned to the same block: mode, organic rate,
the frozen accounting buckets, solvency, epochs, claim status, event log, holder TEN balance.
The page only ever calls `eth_call`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`,
`eth_getCode` (enforced allow-list in `rr-chain.js`).

## 3. Connecting production data (Indexer V1 / epoch artifacts)

Set the adapters in `assets/rr-config.js`:

```js
offchain: Object.freeze({
  indexer:   { getHolder(address), getRateHistory() },
  artifacts: { getEpochArtifact(epochId), verifyDataRef(artifact, onchainDataRef), getHolderEpochs(address) /* optional */ }
})
```

The exact payload shapes (`rr-holder/1`, `rr-rate/1`, `rr-epoch/1`) are documented at the top of
`assets/rr-providers.js`. Every payload is validated before use; a bad payload shows an error
state, never partial numbers. The adapter decides the transport (static JSON, IPFS, an API);
the page does not assume one.

`verifyDataRef` must prove the artifact **content** is what the on-chain `dataRef` commits to
(per the frozen publication format). Until it returns `'match'`, the epoch stays in
**VERIFICATION PENDING** and no claim parameters are shown.

Claim parameters are shown only when all of these pass for the holder:
epoch id · root = on-chain root · committed total = on-chain · Σ allocations = committed total ·
dataRef = on-chain dataRef · content bound to dataRef · `verifyAllocation()` = true ·
`claim()` dry-run via `eth_call` from the holder address succeeds (read-only, never sent).

## 4. Test locally

```sh
cd reward-reserve && python3 -m http.server 8080   # then open http://localhost:8080/
npm install && npm test                             # headless render + safety tests (from repo root)
```

Tests replay a recorded mainnet snapshot and synthetic, clearly fake claim data. They never touch
the production page.
