# TenTen Reward Reserve — web

Wallet-connected claim page for the TEN Reward Reserve V2, currently on Robinhood Chain
**Testnet**, built as a native extension of tentencapital.net (`/reward-reserve/`). Holders
connect their own wallet, see their weekly sNET allocation and claim it directly — no build
step, no framework, wallet connection via plain EIP-1193 (`window.ethereum`).

- `reward-reserve/` — the static page (drop-in folder)
- `reward-reserve/INTEGRATION.md` — how to publish it, switch to mainnet, and connect the Indexer's epoch data
- `reward-reserve/tests/` — headless render and safety tests (`npm test`)
