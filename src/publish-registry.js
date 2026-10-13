// Publishes the curated Stellar protocol/contract registry to Arkiv.
//
// Idempotent: it reads what the publisher already has on Arkiv, creates what
// is missing, patches what changed, and renews the lease on everything still
// listed. Contracts removed from the registry are not renewed and expire.
//
//   node --env-file=.env src/publish-registry.js            # write
//   node --env-file=.env src/publish-registry.js --dry-run  # show the plan only

import fs from "node:fs"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { i32, str, u64 } from "@arkiv-network/sdk/attr"
import { attr, chunk, fetchAll, publicClient, walletClient } from "./arkiv.js"
import { APP, LIFETIME_DAYS, PUBLISHER, SCHEMA_VERSION, TYPES, groupOf, stellarExpertContractUrl } from "./schema.js"

const DRY_RUN = process.argv.includes("--dry-run")
const BATCH_SIZE = 25

function loadContracts() {
  const files = ["data/contracts.json", "data/discovered.json"].filter((f) => fs.existsSync(f))
  const byId = new Map()
  for (const file of files) {
    for (const c of JSON.parse(fs.readFileSync(file, "utf8"))) {
      if (!byId.has(c.contractId)) byId.set(c.contractId, { origin: file.includes("discovered") ? "discovered" : "curated", ...c })
    }
  }
  return [...byId.values()]
}

function contractEntity(c, now) {
  const attributes = {
    app: str(APP),
    type: str(TYPES.contract),
    schema: i32(SCHEMA_VERSION),
    contract: str(c.contractId),
    protocol: str(c.protocol),
    category: str(c.category),
    group: str(groupOf(c.category)),
    origin: str(c.origin),
    listed_at: u64(BigInt(now)),
  }
  if (c.assetCode) attributes.asset = str(c.assetCode)
  return {
    attributes,
    payload: jsonToPayload({
      contractId: c.contractId,
      protocol: c.protocol,
      category: c.category,
      assetCode: c.assetCode ?? null,
      origin: c.origin,
      explorer: stellarExpertContractUrl(c.contractId),
    }),
    contentType: "application/json",
  }
}

function protocolEntity(name, contracts, now) {
  const categories = [...new Set(contracts.map((c) => c.category))].sort()
  const groups = [...new Set(categories.map(groupOf))].sort()
  return {
    attributes: {
      app: str(APP),
      type: str(TYPES.protocol),
      schema: i32(SCHEMA_VERSION),
      protocol: str(name),
      group: str(groups[0]),
      contracts: i32(contracts.length),
      updated_at: u64(BigInt(now)),
    },
    payload: jsonToPayload({ protocol: name, groups, categories, contractCount: contracts.length }),
    contentType: "application/json",
  }
}

// What changed between the wanted entity and the one on Arkiv, ignoring timestamps.
function differs(existing, wanted, ignore) {
  for (const [name, value] of Object.entries(wanted.attributes)) {
    if (ignore.includes(name)) continue
    if (String(attr(existing, name)) !== String(value.value ?? value)) return true
  }
  return false
}

async function main() {
  const now = Date.now()
  const contracts = loadContracts()
  const byProtocol = Map.groupBy(contracts, (c) => c.protocol)

  const reader = publicClient()
  const [onChainContracts, onChainProtocols] = await Promise.all([
    fetchAll(reader, TYPES.contract, { creator: PUBLISHER }),
    fetchAll(reader, TYPES.protocol, { creator: PUBLISHER }),
  ])
  const existingContract = new Map(onChainContracts.map((e) => [attr(e, "contract"), e]))
  const existingProtocol = new Map(onChainProtocols.map((e) => [attr(e, "protocol"), e]))

  const creates = []
  const patches = []
  const extensions = []
  const lease = (type) => ExpirationTime.fromDays(LIFETIME_DAYS[type])

  const plan = (wanted, existing, type, ignore) => {
    if (!existing) {
      creates.push({ ...wanted, expires: lease(type), flags: { permissionlessExtension: true } })
      return
    }
    if (differs(existing, wanted, ignore)) {
      patches.push({ entityKey: existing.key, set: wanted.attributes, payload: wanted.payload, contentType: wanted.contentType })
    }
    extensions.push({ entityKey: existing.key, expires: lease(type) })
  }

  for (const c of contracts) plan(contractEntity(c, now), existingContract.get(c.contractId), TYPES.contract, ["listed_at"])
  for (const [name, list] of byProtocol) plan(protocolEntity(name, list, now), existingProtocol.get(name), TYPES.protocol, ["updated_at"])

  const listed = new Set(contracts.map((c) => c.contractId))
  const dropped = onChainContracts.filter((e) => !listed.has(attr(e, "contract"))).length

  console.log(`registry: ${contracts.length} contracts, ${byProtocol.size} protocols`)
  console.log(`on Arkiv: ${onChainContracts.length} contracts, ${onChainProtocols.length} protocols`)
  console.log(`plan: create ${creates.length}, patch ${patches.length}, renew ${extensions.length}, left to expire ${dropped}`)
  if (DRY_RUN) return

  const writer = walletClient()
  const receipts = []
  // Patches and renewals go in separate transactions so a renewal never races a patch on the same key.
  for (const batch of chunk(creates, BATCH_SIZE)) receipts.push(await writer.executeBatch({ creates: batch }))
  for (const batch of chunk(patches, BATCH_SIZE)) receipts.push(await writer.executeBatch({ patches: batch }))
  for (const batch of chunk(extensions, BATCH_SIZE)) receipts.push(await writer.executeBatch({ extensions: batch }))

  for (const r of receipts) {
    const n = r.createdEntities.length + r.patchedEntities.length + r.extendedEntities.length
    console.log(`tx ${r.txHash}: ${n} entities`)
  }
  fs.mkdirSync("runs", { recursive: true })
  fs.writeFileSync(
    `runs/registry-${new Date(now).toISOString().slice(0, 19).replace(/:/g, "")}.json`,
    JSON.stringify({ at: new Date(now).toISOString(), publisher: PUBLISHER, txs: receipts.map((r) => r.txHash) }, null, 2) + "\n",
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
