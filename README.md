# LCRD Open Registry

An open registry of Stellar DeFi protocols, their Soroban contracts and their daily activity, stored on [Arkiv](https://arkiv.network), the Web3 database.

Anyone can read it, query it and build on it without asking us and without an LCRD server.

- **Live app:** _link added at deploy_
- **Data contract:** [`arkiv/schema.md`](arkiv/schema.md)
- **Friction report:** [`arkiv/friction.md`](arkiv/friction.md)
- **Publisher wallet:** `0xFD52Dc5DBa1Aa937E90EE87AcD99a7e433AAa9B7` on Tiramisu ([explorer](https://tiramisu.explorer.arkiv.network/address/0xFD52Dc5DBa1Aa937E90EE87AcD99a7e433AAa9B7))

## Why it exists

Stellar has no subgraph. To know which contracts belong to Blend, Aquarius, Etherfuse or Spiko, every wallet, lender, analyst and indexer either redoes the research or trusts someone's private API. When that API goes away, so does the map.

LCRD built that map for its own credit indexer: 75 hand-checked contracts across 22 protocols, each traced to the protocol's own docs or DefiLlama's adapter source. This project publishes it, plus a daily activity summary per protocol, as Arkiv entities:

- **Censorship resistance:** the web app and CLI read Arkiv directly. Turn off every LCRD server and they still work. Registry entities allow permissionless Lifetime Extension, so anyone can keep them alive.
- **Open source:** a documented data contract ([`arkiv/schema.md`](arkiv/schema.md)) that another team can query or fork without permission.
- **Verifiable authorship:** curated entries are the ones whose on-chain `$creator` is the publisher. Community submissions are shown under their own creator, as unverified.

## How it works

```
data/contracts.json ──► publish-registry ──► Arkiv: protocol + contract entities (30-day lease, renewed each run)
Stellar RPC getEvents ──► publish-stats ────► Arkiv: protocol_day entities (14-day window)
                                               │
                         web app, CLI ◄────────┘  reads Arkiv directly, live over WebSocket
                         any wallet ──────────►   Arkiv: claim entities (7-day review window)
```

| Path | What it does |
|---|---|
| `src/schema.js` | Entity types, lifetimes, groups. Shared by every part |
| `src/publish-registry.js` | Diffs the registry against Arkiv, then creates, patches and renews in batches |
| `src/stellar-events.js` | Reads one UTC day of events for every listed contract from public Stellar RPC and aggregates per protocol |
| `src/publish-stats.js` | Writes that day as `protocol_day` entities |
| `src/cli.js` | Read-only CLI: `protocols`, `contracts`, `lookup`, `activity`, `claims` |
| `web/` | Static web app: registry, daily activity, community submissions. No build step |

## Run it

Node.js 22 or newer.

```bash
npm install
```

**Read** (no key needed):

```bash
node src/cli.js protocols
node src/cli.js contracts --group lending
node src/cli.js lookup CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD
node src/cli.js activity --protocol aquarius --days 7
node src/cli.js claims
```

Add `--json` for machine-readable output, or `--creator 0x…` to read a fork published by another wallet.

**Web app** (any static server, from the repo root):

```bash
python3 -m http.server 8787
```

Then open http://localhost:8787/web/.

**Publish** (your own fork):

1. `cp .env.example .env` and set `PUBLISHER_PRIVATE_KEY` to a new testnet key.
2. Fund its address at https://hub.arkiv.network/faucet.
3. Set `PUBLISHER` in `src/schema.js` to that address.
4. Run:

```bash
node --env-file=.env src/publish-registry.js --dry-run
node --env-file=.env src/publish-registry.js
node --env-file=.env src/publish-stats.js            # yesterday, UTC
node --env-file=.env src/publish-stats.js --day 20261012
```

Each run writes its transaction hashes to `runs/`.

## Pre-existing work

The contract list in `data/contracts.json` was researched before this challenge for LCRD's Stellar credit indexer (`lucred-wallet-connect`, `backend/indexer/src/registry.ts`, baseline commit `6cff555c943c4c734880008a82b708ceb6f70d37`). It was extracted as data only. Everything else here, including the Arkiv schema, publishers, Stellar event aggregation, CLI and web app, was written between 9 and 18 October 2026.

## Licence

MIT
