// Writes a JSON snapshot of everything this app has on Arkiv, read with an
// API key. The web app falls back to it only when a visitor's anonymous
// Arkiv reads are rate-limited, and says so on the page.
//
//   node --env-file=.env src/snapshot.js > snapshot.json

import { str } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { publicClient } from "./arkiv.js"
import { APP, PUBLISHER, TYPES } from "./schema.js"

const client = publicClient()

async function fetchAll(extra, creator) {
  let q = client
    .select({ key: true, attributes: true, payload: true, contentType: true, creator: true, expiresAt: true })
    .where(eq("app", str(APP)), ...extra)
    .limit(200)
  if (creator) q = q.createdBy(creator)
  let page = await q.fetch()
  const block = page.blockNumber
  const out = [...page.entities]
  while (page.hasNextPage()) {
    page = await page.next()
    out.push(...page.entities)
  }
  return { block, entities: out }
}

const plain = (e) => ({
  key: e.key,
  creator: e.creator,
  expiresAt: String(e.expiresAt),
  attributes: Object.fromEntries(Object.entries(e.attributes).map(([k, a]) => [k, { type: a.type, value: String(a.value) }])),
  payload: e.contentType === "application/json" ? e.toJson() : null,
})

const published = await fetchAll([], PUBLISHER)
const claims = await fetchAll([eq("type", str(TYPES.claim))])

process.stdout.write(
  JSON.stringify({
    app: APP,
    publisher: PUBLISHER,
    block: String(published.block),
    takenAt: new Date().toISOString(),
    entities: [...published.entities, ...claims.entities].map(plain),
  }) + "\n",
)
