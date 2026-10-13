import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { str } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { APP } from "./schema.js"

// No retries: viem honours Retry-After, which on a rate-limited Arkiv RPC can be
// 20+ minutes of silent waiting. Every script here is safe to rerun instead.
const transport = () => http(process.env.ARKIV_RPC_URL || undefined, { timeout: 30_000, retryCount: 0 })

export function publicClient() {
  return createPublicClient({ chain: tiramisu, transport: transport() })
}

export function walletClient() {
  const key = process.env.PUBLISHER_PRIVATE_KEY
  if (!key) throw new Error("PUBLISHER_PRIVATE_KEY is not set (see .env.example)")
  return createWalletClient({ chain: tiramisu, transport: transport(), account: privateKeyToAccount(key) })
}

// Every entity of one type this app's publisher created, across all pages.
export async function fetchAll(client, type, { creator, extra = [] } = {}) {
  let q = client
    .select({ key: true, attributes: true, payload: true, contentType: true, expiresAt: true, creator: true })
    .where(eq("app", str(APP)), eq("type", str(type)), ...extra)
    .limit(200)
  if (creator) q = q.createdBy(creator)
  let page = await q.fetch()
  const out = [...page.entities]
  while (page.hasNextPage()) {
    page = await page.next()
    out.push(...page.entities)
  }
  return out
}

// Attribute value as a plain JS value.
export function attr(entity, name) {
  return entity.attributes?.[name]?.value
}

export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
