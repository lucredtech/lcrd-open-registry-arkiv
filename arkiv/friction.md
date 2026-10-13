# Friction report

What we hit while building LCRD Open Registry on Arkiv, and what we tested that worked. Each entry lists the surface, what we expected, what happened, and how to reproduce it.

**Environment:** `@arkiv-network/sdk` 0.8.1, `viem` 2.57.5, Node.js 22.23.1, macOS, Tiramisu testnet (chain `7738577`), public RPC with no access key. Dates are October 2026.

---

## 1. A rate-limited query hangs for 20+ minutes with no error

**Surface:** Public RPC (`https://rpc.tiramisu.db-chain.testnet.arkiv.network`) with the TypeScript SDK's default `http()` transport

**Expected:** When the anonymous query budget runs out, the call fails quickly with a message like "get an API key".

**Actual:** After a few dozen dry runs and page loads in one afternoon, our publisher and CLI just stopped: no output, no error, for over five minutes. The node answers `arkiv_query` with `HTTP 429`, `retry-after: 1348`, and the body `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`. viem's HTTP transport honours `Retry-After`, so the SDK silently sleeps about 22 minutes before retrying. The helpful message in the body never reaches the developer. The budget is cost-based (`ratelimit: limit=10000`), and it is not obvious beforehand how many queries that allows.

**Reproduce:**
1. Exhaust the anonymous budget from one IP (repeated paged queries, e.g. `node src/cli.js contracts` in a loop).
2. Run any `client.select(...).fetch()` with `createPublicClient({ chain: tiramisu, transport: http() })`. It hangs.
3. `curl -i -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = \"x\"",{}]}' https://rpc.tiramisu.db-chain.testnet.arkiv.network` shows the 429 and the message.

**Workaround:** `http(url, { retryCount: 0, timeout: 30_000 })` in [`src/arkiv.js`](../src/arkiv.js), so a 429 fails at once with `Status: 429`, and an API key from the Hub for the publisher.

**Would fix it:** Have the SDK's default transport not retry on `ANON_COST_LIMITED` (or cap the `Retry-After` it will wait for), and surface the body's message as a typed error. A sentence on the Tiramisu page about the anonymous budget size would help too, and `Arkiv-Quota-Used-Percent` is already exposed, so the SDK could warn as it approaches 100%.

## 2. `exists()` and `ne()` are exported but the node rejects them with an unrelated error

**Surface:** TypeScript SDK, query builder (`@arkiv-network/sdk/query`)

**Expected:** Either the query runs, or it fails with a message saying the operator is not supported yet.

**Actual:** Both throw `Query rejected (type, -32002): Requested resource not available.` That reads like a missing entity or an RPC outage, not an unsupported operator. The docs do mention that `ne`, `exists` and `hasType` are not supported yet, but the SDK still exports them with no warning, and the error does not point there.

**Reproduce:**
```ts
import * as q from "@arkiv-network/sdk/query"
await client.select({ key: true }).where(q.eq("app", str("lcrd-open-registry")), q.exists("asset")).fetch()
await client.select({ key: true }).where(q.ne("app", str("x"))).limit(1).fetch()
```

**Workaround:** `not(eq(...))` works. For "has an asset", we read the attribute on the client.

**Would fix it:** Mark these as `@deprecated` or `@experimental` in the type definitions so editors flag them, or have the SDK throw `QueryError("exists() is not supported by the network yet")` before sending.

## 3. A numeric type mismatch silently returns no results

**Surface:** TypeScript SDK, queries on numeric attributes

**Expected:** A warning or error when a range filter's type does not match how the attribute is stored.

**Actual:** `day` is stored as `i32`. Querying `gte("day", u64(1n))` returns 0 entities and no error. During development this looks exactly like "no data published yet". The docs do warn about it, which is how we found the cause.

**Reproduce:**
```ts
await client.select({ key: true })
  .where(eq("app", str("lcrd-open-registry")), gte("day", u64(1n)))
  .fetch()   // 0 results; with i32(1) it matches
```

**Would fix it:** The node knows each attribute's stored type (the `attributeSchema` field exists). A debug flag, or a warning when a predicate's type matches nothing in the attribute schema, would save the guesswork.

## 4. A write from an unfunded wallet fails without saying it is unfunded

**Surface:** TypeScript SDK, `createEntity` (wallet client)

**Expected:** An "insufficient funds" style error, since the account has 0 GLM.

**Actual:** `EntityMutationError: Transaction failed: Execution error without revert data`.

**Reproduce:** Generate a new key with `viem/accounts`, do not fund it, then call `walletClient.createEntity({...})` with any valid entity.

**Would fix it:** Check the balance (or catch the node's funds error) inside `sendArkivTransaction` and raise a clear `InsufficientFundsError` that links to the faucet.

## 5. The live-events docs show only HTTP polling

**Surface:** Docs, Live events page

**Expected:** An example of `watchEntityEvents` over `webSocket()`, since the Tiramisu page lists a WebSocket endpoint and the challenge materials recommend it for live UIs.

**Actual:** Every example uses `http()`, and the page says the method polls. We read `src/actions/public/watchEntityEvents.ts` to confirm it is built on viem's `watchEvent`, which uses a subscription when the transport is a WebSocket. With `createPublicClient({ chain: tiramisu, transport: webSocket() })` and no `fromBlock`, it works in the browser and our page updates without a refresh loop.

**Would fix it:** A three-line WebSocket example on that page, plus a note that `fromBlock` forces polling.

## 6. Docs import `stringToPayload` from two different paths

**Surface:** Docs, Installation vs Mutating data pages

**Expected:** One import path.

**Actual:** The installation page imports `stringToPayload` from `@arkiv-network/sdk/utils`; the mutating-data page imports it from `@arkiv-network/sdk`. Both work in 0.8.1 (the package exports `./utils`), but it is unclear which one is canonical. We used the root import.

---

## Tested and worked as documented

| Surface | What we did | Result |
|---|---|---|
| Query limits | `.limit(500)` | Clear error: "limit 500 exceeds the node maximum of 200. Page through the results with the cursor instead." Good message. |
| Cursor pagination | `page.hasNextPage()` / `page.next()` across all `contract` entities | Worked |
| `createdBy()` | Filtering curated data by the publisher address | Worked |
| `not(eq())` | Instead of `ne()` | Worked |
| Browser ESM | `esm.sh/@arkiv-network/sdk@0.8.1?target=es2022&bundle-deps` with `viem` from esm.sh, no bundler | Worked; transports from a separate viem import are accepted |
| WebSocket events | `watchEntityEvents` over `webSocket()` in the browser | Connected; see item 4 |
