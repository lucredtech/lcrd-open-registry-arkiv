// Data contract for LCRD Open Registry entities on Arkiv.
// Shared by the publisher, the CLI and the web app. No dependencies, so the
// browser can import it as-is. Documented in arkiv/schema.md.

export const APP = "lcrd-open-registry"
export const SCHEMA_VERSION = 1

// The wallet that publishes the curated registry. Readers filter on
// $creator === PUBLISHER to tell curated entries from community claims.
export const PUBLISHER = "0xFD52Dc5DBa1Aa937E90EE87AcD99a7e433AAa9B7"

export const TYPES = {
  protocol: "protocol",
  contract: "contract",
  protocolDay: "protocol_day",
  claim: "claim",
}

// Lifetimes, in days, per entity type.
//  - protocol / contract: a 30-day lease the publisher renews on every run.
//    A contract dropped from the registry is simply not renewed and fades out.
//    Both allow permissionless extension, so anyone can keep the registry
//    alive if the publisher disappears.
//  - protocol_day: a rolling two-week window of daily activity. Not extendable.
//  - claim: a community submission waits 7 days for review, then expires.
export const LIFETIME_DAYS = {
  protocol: 30,
  contract: 30,
  protocol_day: 14,
  claim: 7,
}

// Registry categories grouped into the few buckets people filter by.
export const GROUPS = {
  lending: ["lending_pool", "lending_pool_factory", "lending_backstop", "lending_debt"],
  amm: ["amm_liquidity", "amm_factory", "amm_router", "amm_pair"],
  yield: ["yield_savings", "yield_vault"],
  rwa: ["rwa_treasury", "rwa_credit", "rwa_trade_finance"],
  other: ["mass_distribution", "wrapped_asset"],
}

export function groupOf(category) {
  for (const [group, categories] of Object.entries(GROUPS)) {
    if (categories.includes(category)) return group
  }
  return "other"
}

// UTC day as a sortable integer, e.g. 2026-10-12 -> 20261012.
export function dayNumber(date) {
  const d = new Date(date)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

export function stellarExpertContractUrl(contractId) {
  return `https://stellar.expert/explorer/public/contract/${contractId}`
}
