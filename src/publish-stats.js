// Publishes one UTC day of per-protocol activity to Arkiv as protocol_day
// entities, computed from public Stellar RPC so anyone can rerun it.
//
//   node --env-file=.env src/publish-stats.js                 # yesterday (UTC)
//   node --env-file=.env src/publish-stats.js --day 20261012
//   node --env-file=.env src/publish-stats.js --dry-run

import fs from "node:fs"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { i32, str, u64 } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { attr, chunk, fetchAll, publicClient, walletClient } from "./arkiv.js"
import { APP, LIFETIME_DAYS, PUBLISHER, SCHEMA_VERSION, TYPES, dayNumber } from "./schema.js"
import { protocolDayStats } from "./stellar-events.js"

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const dayArg = args.includes("--day") ? Number(args[args.indexOf("--day") + 1]) : null
const day = dayArg ?? dayNumber(Date.now() - 86_400_000)

function loadProtocolMap() {
  const map = new Map()
  for (const file of ["data/contracts.json", "data/discovered.json"]) {
    if (!fs.existsSync(file)) continue
    for (const c of JSON.parse(fs.readFileSync(file, "utf8"))) map.set(c.contractId, c.protocol)
  }
  return map
}

function dayEntity(stats, p, now) {
  return {
    attributes: {
      app: str(APP),
      type: str(TYPES.protocolDay),
      schema: i32(SCHEMA_VERSION),
      protocol: str(p.protocol),
      day: i32(stats.day),
      events: u64(BigInt(p.events)),
      wallets: i32(p.wallets),
      active_contracts: i32(p.activeContracts),
      computed_at: u64(BigInt(now)),
    },
    payload: jsonToPayload({
      day: stats.day,
      protocol: p.protocol,
      events: p.events,
      wallets: p.wallets,
      byAction: p.byAction,
      byContract: p.byContract,
      source: { method: "getEvents", rpc: stats.rpc, ledgerFrom: stats.ledgerFrom, ledgerTo: stats.ledgerTo },
    }),
    contentType: "application/json",
  }
}

async function main() {
  const now = Date.now()
  const protocolOf = loadProtocolMap()
  console.log(`day ${day}: scanning ${protocolOf.size} contracts`)
  const stats = await protocolDayStats(day, protocolOf, { rpcUrl: process.env.STELLAR_RPC_URL, log: console.log })
  stats.protocols.sort((a, b) => b.events - a.events)
  for (const p of stats.protocols) console.log(`  ${p.protocol.padEnd(26)} ${String(p.events).padStart(7)} events ${String(p.wallets).padStart(6)} wallets`)

  const existing = await fetchAll(publicClient(), TYPES.protocolDay, { creator: PUBLISHER, extra: [eq("day", i32(day))] })
  const existingByProtocol = new Map(existing.map((e) => [attr(e, "protocol"), e]))

  const creates = []
  const patches = []
  for (const p of stats.protocols) {
    const wanted = dayEntity(stats, p, now)
    const found = existingByProtocol.get(p.protocol)
    if (found) patches.push({ entityKey: found.key, set: wanted.attributes, payload: wanted.payload, contentType: wanted.contentType })
    else creates.push({ ...wanted, expires: ExpirationTime.fromDays(LIFETIME_DAYS.protocol_day) })
  }
  console.log(`plan: create ${creates.length}, patch ${patches.length}`)
  if (DRY_RUN) return

  const writer = walletClient()
  const txs = []
  for (const batch of chunk(creates, 25)) txs.push((await writer.executeBatch({ creates: batch })).txHash)
  for (const batch of chunk(patches, 25)) txs.push((await writer.executeBatch({ patches: batch })).txHash)
  for (const tx of txs) console.log(`tx ${tx}`)

  fs.mkdirSync("runs", { recursive: true })
  fs.writeFileSync(`runs/stats-${day}.json`, JSON.stringify({ at: new Date(now).toISOString(), day, publisher: PUBLISHER, txs }, null, 2) + "\n")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
