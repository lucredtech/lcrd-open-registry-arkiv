# Arkiv schema

LCRD Open Registry stores four entity types on Arkiv (Tiramisu testnet, chain ID `7738577`). Every entity carries `app = "lcrd-open-registry"` and a `type`, so one query prefix finds everything this project writes.

The shared constants live in [`src/schema.js`](../src/schema.js), which the publisher, the CLI and the web app all import.

## Who writes what

| Wallet | Role | Writes |
|---|---|---|
| `0xFD52Dc5DBa1Aa937E90EE87AcD99a7e433AAa9B7` | LCRD publisher | `protocol`, `contract`, `protocol_day` |
| Any wallet | Community member | `claim` |

Trust comes from `$creator`, never from an attribute. The web app and the CLI read curated data with `.createdBy(PUBLISHER)`. A `claim` is shown with its creator's address and labelled unverified, whoever wrote it.

## Entity types

### `protocol`: one per Stellar DeFi protocol

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `app` | str | `lcrd-open-registry` | |
| `type` | str | `protocol` | |
| `schema` | i32 | `1` | Data contract version |
| `protocol` | str | `blend` | Stable slug, the join key with `contract` and `protocol_day` |
| `group` | str | `lending` | `lending` · `amm` · `yield` · `rwa` · `other` |
| `contracts` | i32 | `14` | Number of listed contracts |
| `updated_at` | u64 | `1791916000000` | Unix ms of the publisher run |

Payload (`application/json`): `{ protocol, groups[], categories[], contractCount }`.

**Expiration:** 30 days, renewed by every publisher run (Lifetime Extension as a lease). Created with `permissionlessExtension: true`, so anyone can extend it if the publisher stops.

### `contract`: one per Soroban contract

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `app`, `type`, `schema` | | `contract` | |
| `contract` | str | `CAJJZS…YBXBD` | Stellar contract ID (56 chars) |
| `protocol` | str | `blend` | |
| `category` | str | `lending_pool` | Fine-grained role of the contract |
| `group` | str | `lending` | Derived from `category` |
| `asset` | str | `USDC` | Only for one-asset contracts such as per-asset vaults |
| `origin` | str | `curated` | `curated` (hand-researched) or `discovered` (found from a factory) |
| `listed_at` | u64 | `1791916000000` | Unix ms of the last publish |

Payload: `{ contractId, protocol, category, assetCode, origin, explorer }`.

**Expiration:** 30 days, renewed on every run while the contract is still listed. A contract removed from the registry is not renewed and drops out on its own after 30 days, so the registry never needs a delete. `permissionlessExtension: true`, as for `protocol`.

### `protocol_day`: one per protocol per UTC day

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `app`, `type`, `schema` | | `protocol_day` | |
| `protocol` | str | `aquarius` | |
| `day` | i32 | `20261012` | UTC day as `YYYYMMDD`, numeric so it supports ranges |
| `events` | u64 | `2931` | Successful contract events that day |
| `wallets` | i32 | `49` | Distinct G… accounts in event topics. A count only |
| `active_contracts` | i32 | `12` | Listed contracts with at least one event |
| `computed_at` | u64 | `1791916000000` | Unix ms |

Payload: `{ day, protocol, events, wallets, byAction{}, byContract{}, source{ method, rpc, ledgerFrom, ledgerTo } }`. `byContract` keys are contract IDs, never wallets.

**Expiration:** 14 days, not extendable. The page shows a rolling two-week window, so older days expire by design. A rerun for the same day patches the existing entity instead of creating a duplicate.

### `claim`: a community submission of a missing contract

| Attribute | Type | Example |
|---|---|---|
| `app`, `type`, `schema` | | `claim` |
| `contract` | str | `C…` |
| `protocol` | str | `soroswap` |
| `category` | str | `amm_pair` |
| `submitted_at` | u64 | `1791916000000` |

Payload: `{ contractId, protocol, category, note }`.

**Expiration:** 7 days. That is the review window. An accepted claim becomes a curated `contract` entity created by the publisher; the claim itself just expires.

## What stays off Arkiv on purpose

- **Wallet-level data.** The indexer behind LCRD sees which wallet did what. None of that goes to Arkiv: `protocol_day` holds counts, and the distinct-wallet count is computed in memory and discarded. Credit scores and holdings stay off too.
- **Raw ledgers and events.** Stellar already stores them; Arkiv holds the curated index over them, not a copy.
- **The publisher key.** Read from an environment variable, never written anywhere.

## Queries the app runs

All queries are in [`src/cli.js`](../src/cli.js) and [`web/app.js`](../web/app.js). Results are paged with the cursor at 200 per page, and every walk is pinned with `.atBlock(head - 2)` so all pages read the same block (see friction item 7).

```ts
// Everything the publisher wrote, in one paged query (web app page load; split by type on the client)
client.select({ key: true, attributes: true, payload: true, creator: true, expiresAt: true })
  .where(eq("app", str("lcrd-open-registry"))).createdBy(PUBLISHER).limit(200).fetch()

// Curated contracts in one group (CLI: contracts --group)
client.select({ key: true, attributes: true, payload: true })
  .where(eq("app", str("lcrd-open-registry")), eq("type", str("contract")), eq("group", str("lending")))
  .createdBy(PUBLISHER).limit(200).fetch()

// Is this contract in the registry? (CLI: lookup)
.where(eq("app", str(APP)), eq("type", str("contract")), eq("contract", str(contractId))).createdBy(PUBLISHER)

// The last N days of activity, optionally for one protocol (CLI: activity)
.where(eq("app", str(APP)), eq("type", str("protocol_day")), gte("day", i32(20260929)), eq("protocol", str("blend")))
  .createdBy(PUBLISHER)

// Community claims from anyone (web: Community submissions, CLI: claims)
.where(eq("app", str(APP)), eq("type", str("claim")))

// The publisher's own state before a run, to diff and renew (src/publish-registry.js)
.where(eq("app", str(APP)), eq("type", str("contract"))).createdBy(PUBLISHER)
```

There is no server-side ordering, so the app sorts on the client: by `events` for activity and by `protocol` for the registry.

Each query costs 100 units of a visitor's anonymous quota (about 10,000 per hour per IP on Tiramisu), so the web app loads with two queries, everything from the publisher plus all claims, instead of one per table.

## Live updates

The web app opens `watchEntityEvents` over a WebSocket transport (`wss://rpc.tiramisu.db-chain.testnet.arkiv.network`, no `fromBlock`). Tiramisu carries every app's events, and each query costs part of the visitor's anonymous quota, so the page filters on the event's indexed `owner` for free. It reacts only to events whose owner is the publisher, or whose entity is already on the page. A burst of events, such as one publisher run, triggers a single reload, and the new rows are highlighted. A claim from someone else shows up on the next page load; your own claim shows up at once.

## Writes

- `src/publish-registry.js`: `executeBatch` with up to 25 creates, then patches, then renewals (`extensions`) per transaction.
- `src/publish-stats.js`: `executeBatch` creates or patches for one day.
- `web/app.js`: `createEntity` from the visitor's own wallet for a `claim`.
