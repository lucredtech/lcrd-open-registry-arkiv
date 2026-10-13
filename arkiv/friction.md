# Friction report

What we hit while building LCRD Open Registry on Arkiv, and what we tested that worked. Each entry lists the surface, what we expected, what happened, and how to reproduce it.

**Environment:** `@arkiv-network/sdk` 0.8.1, `viem` 2.57.5, Node.js 22.23.1, macOS, Tiramisu testnet (chain `7738577`), public RPC with no access key. Dates are October 2026.

---

## 1. `exists()` and `ne()` are exported but the node rejects them with an unrelated error

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

## 2. A numeric type mismatch silently returns no results

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

## 3. A write from an unfunded wallet fails without saying it is unfunded

**Surface:** TypeScript SDK, `createEntity` (wallet client)

**Expected:** An "insufficient funds" style error, since the account has 0 GLM.

**Actual:** `EntityMutationError: Transaction failed: Execution error without revert data`.

**Reproduce:** Generate a new key with `viem/accounts`, do not fund it, then call `walletClient.createEntity({...})` with any valid entity.

**Would fix it:** Check the balance (or catch the node's funds error) inside `sendArkivTransaction` and raise a clear `InsufficientFundsError` that links to the faucet.

## 4. The live-events docs show only HTTP polling

**Surface:** Docs, Live events page

**Expected:** An example of `watchEntityEvents` over `webSocket()`, since the Tiramisu page lists a WebSocket endpoint and the challenge materials recommend it for live UIs.

**Actual:** Every example uses `http()`, and the page says the method polls. We read `src/actions/public/watchEntityEvents.ts` to confirm it is built on viem's `watchEvent`, which uses a subscription when the transport is a WebSocket. With `createPublicClient({ chain: tiramisu, transport: webSocket() })` and no `fromBlock`, it works in the browser and our page updates without a refresh loop.

**Would fix it:** A three-line WebSocket example on that page, plus a note that `fromBlock` forces polling.

## 5. Docs import `stringToPayload` from two different paths

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
