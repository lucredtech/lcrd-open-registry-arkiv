#!/usr/bin/env node
// Read-only CLI over the registry on Arkiv. Needs no key and no LCRD backend.
//
//   lcrd-registry protocols [--group lending]
//   lcrd-registry contracts [--protocol blend] [--group amm]
//   lcrd-registry lookup <contractId>
//   lcrd-registry activity [--protocol blend] [--days 7]
//   lcrd-registry claims
//
// Curated data is filtered by $creator = the LCRD publisher. Pass --creator 0x…
// to read a fork published by someone else.

import { str, i32 } from "@arkiv-network/sdk/attr"
import { eq, gte } from "@arkiv-network/sdk/query"
import { attr, fetchAll, publicClient } from "./arkiv.js"
import { PUBLISHER, TYPES, dayNumber } from "./schema.js"

const [command, ...rest] = process.argv.slice(2)
const opt = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined)
const creator = opt("creator") ?? PUBLISHER
const json = rest.includes("--json")
const client = publicClient()

function print(rows, columns) {
  if (json) return console.log(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? Number(v) : v), 2))
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)))
  console.log(columns.map((c, i) => c.padEnd(widths[i])).join("  "))
  for (const r of rows) console.log(columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  "))
  console.log(`\n${rows.length} rows · creator ${creator}`)
}

const commands = {
  async protocols() {
    const extra = opt("group") ? [eq("group", str(opt("group")))] : []
    const rows = (await fetchAll(client, TYPES.protocol, { creator, extra }))
      .map((e) => ({ protocol: attr(e, "protocol"), group: attr(e, "group"), contracts: attr(e, "contracts"), key: e.key }))
      .sort((a, b) => b.contracts - a.contracts)
    print(rows, ["protocol", "group", "contracts", "key"])
  },

  async contracts() {
    const extra = []
    if (opt("protocol")) extra.push(eq("protocol", str(opt("protocol"))))
    if (opt("group")) extra.push(eq("group", str(opt("group"))))
    const rows = (await fetchAll(client, TYPES.contract, { creator, extra }))
      .map((e) => ({
        contract: attr(e, "contract"),
        protocol: attr(e, "protocol"),
        category: attr(e, "category"),
        asset: attr(e, "asset") ?? "",
      }))
      .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.category.localeCompare(b.category))
    print(rows, ["contract", "protocol", "category", "asset"])
  },

  async lookup() {
    const id = rest.find((a) => !a.startsWith("--"))
    if (!id) throw new Error("usage: lookup <contractId>")
    const [hit] = await fetchAll(client, TYPES.contract, { creator, extra: [eq("contract", str(id))] })
    if (!hit) {
      const claims = await fetchAll(client, TYPES.claim, { extra: [eq("contract", str(id))] })
      console.log(claims.length ? `not curated; ${claims.length} community claim(s), see \`claims\`` : "not in the registry")
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify({ key: hit.key, creator: hit.creator, expiresAtBlock: Number(hit.expiresAt), ...hit.toJson() }, null, 2))
  },

  async activity() {
    const days = Number(opt("days") ?? 7)
    const since = dayNumber(Date.now() - days * 86_400_000)
    const extra = [gte("day", i32(since))]
    if (opt("protocol")) extra.push(eq("protocol", str(opt("protocol"))))
    const rows = (await fetchAll(client, TYPES.protocolDay, { creator, extra }))
      .map((e) => ({
        day: attr(e, "day"),
        protocol: attr(e, "protocol"),
        events: attr(e, "events"),
        wallets: attr(e, "wallets"),
        contracts: attr(e, "active_contracts"),
      }))
      .sort((a, b) => b.day - a.day || Number(b.events - a.events))
    print(rows, ["day", "protocol", "events", "wallets", "contracts"])
  },

  async claims() {
    const rows = (await fetchAll(client, TYPES.claim))
      .map((e) => ({
        contract: attr(e, "contract"),
        protocol: attr(e, "protocol"),
        category: attr(e, "category"),
        by: e.creator,
      }))
    print(rows, ["contract", "protocol", "category", "by"])
  },
}

if (!commands[command]) {
  console.log("usage: lcrd-registry <protocols|contracts|lookup|activity|claims> [--protocol p] [--group g] [--days n] [--creator 0x…] [--json]")
  process.exit(command ? 1 : 0)
}
commands[command]().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
