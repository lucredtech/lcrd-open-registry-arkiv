// Reads one UTC day of Soroban contract events from a public Stellar RPC and
// aggregates them per protocol. Only counts leave this module: wallet
// addresses are used to count distinct wallets and then dropped.

const DEFAULT_RPC = "https://soroban-rpc.mainnet.stellar.gateway.fm"
// Mainnet closes a ledger about every 5 s. Using a slightly shorter time
// overestimates the range, so the scan never starts late or stops early.
const SECONDS_PER_LEDGER = 4.8
const PAGE_LIMIT = 10000
const IDS_PER_FILTER = 5
const FILTERS_PER_REQUEST = 5

const SCV_STRING = 14
const SCV_SYMBOL = 15
const SCV_ADDRESS = 18
const SC_ADDRESS_ACCOUNT = 0
const SC_ADDRESS_MUXED_ACCOUNT = 2

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
  return body.result
}

// The event name: the first topic, a Symbol or String ScVal.
export function eventName(topicXdr) {
  const buf = Buffer.from(topicXdr, "base64")
  const type = buf.readUInt32BE(0)
  if (type !== SCV_SYMBOL && type !== SCV_STRING) return null
  const len = buf.readUInt32BE(4)
  return buf.toString("utf8", 8, 8 + len)
}

// The ed25519 key of a G... (or muxed M...) account in an Address ScVal, as hex.
// Contract addresses return null: a contract is not a wallet.
export function accountKey(topicXdr) {
  const buf = Buffer.from(topicXdr, "base64")
  if (buf.length < 44 || buf.readUInt32BE(0) !== SCV_ADDRESS) return null
  const kind = buf.readUInt32BE(4)
  if (kind === SC_ADDRESS_ACCOUNT) return buf.subarray(12, 44).toString("hex")
  if (kind === SC_ADDRESS_MUXED_ACCOUNT && buf.length >= 48) return buf.subarray(16, 48).toString("hex")
  return null
}

function dayBounds(day) {
  const start = Date.UTC(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100)
  return { start, end: start + 86_400_000 }
}

/**
 * @param {number} day  UTC day as YYYYMMDD
 * @param {Map<string,string>} protocolOf  contractId -> protocol
 */
export async function protocolDayStats(day, protocolOf, { rpcUrl = DEFAULT_RPC, log = () => {} } = {}) {
  const { start, end } = dayBounds(day)
  const latest = await rpc(rpcUrl, "getLatestLedger", {})
  const latestClose = Number(latest.closeTime) * 1000
  if (end > latestClose) throw new Error(`day ${day} is not over yet on the network`)

  // Estimate the ledger range, with a margin, then trust ledgerClosedAt.
  const ledgersBack = Math.ceil((latestClose - start) / 1000 / SECONDS_PER_LEDGER)
  let startLedger = latest.sequence - ledgersBack - 300
  const endLedger = Math.min(latest.sequence, startLedger + Math.ceil(86_400 / SECONDS_PER_LEDGER) + 300)

  // RPC nodes keep about 7 days of events. Clamp to the oldest ledger, then
  // refuse below if the day itself starts before it: a partial day would
  // publish numbers that look complete but are not.
  // Public RPC endpoints are load-balanced and nodes disagree slightly on
  // their oldest ledger, hence the margin.
  const { oldestLedger } = await rpc(rpcUrl, "getHealth", {})
  const clamped = startLedger <= oldestLedger + 1000
  if (clamped) startLedger = oldestLedger + 1000

  const ids = [...protocolOf.keys()]
  const perProtocol = new Map()
  let firstLedger = Infinity
  let lastLedger = 0

  const groupSize = IDS_PER_FILTER * FILTERS_PER_REQUEST
  for (let g = 0; g < ids.length; g += groupSize) {
    const group = ids.slice(g, g + groupSize)
    const filters = []
    for (let i = 0; i < group.length; i += IDS_PER_FILTER) {
      filters.push({ type: "contract", contractIds: group.slice(i, i + IDS_PER_FILTER) })
    }
    let cursor
    for (;;) {
      // The RPC rejects a ledger range together with a cursor, so later pages
      // carry only the cursor and the loop stops once it passes the day.
      const params = cursor
        ? { filters, pagination: { cursor, limit: PAGE_LIMIT } }
        : { startLedger, endLedger, filters, pagination: { limit: PAGE_LIMIT } }
      const page = await rpc(rpcUrl, "getEvents", params)
      // Where the clamped scan starts, assuming slow (6 s) ledgers to stay on the safe side.
      const scanStartsAt = Number(page.oldestLedgerCloseTime) * 1000 + (startLedger - Number(page.oldestLedger)) * 6000
      if (clamped && scanStartsAt > start) {
        throw new Error(`day ${day} starts before the oldest ledger this RPC keeps (${oldestLedger}); pick a more recent day`)
      }
      for (const ev of page.events) {
        const at = Date.parse(ev.ledgerClosedAt)
        if (at < start || at >= end || !ev.inSuccessfulContractCall) continue
        const protocol = protocolOf.get(ev.contractId)
        if (!protocol) continue
        firstLedger = Math.min(firstLedger, ev.ledger)
        lastLedger = Math.max(lastLedger, ev.ledger)

        let s = perProtocol.get(protocol)
        if (!s) {
          s = { events: 0, wallets: new Set(), contracts: new Map(), actions: new Map() }
          perProtocol.set(protocol, s)
        }
        s.events++
        s.contracts.set(ev.contractId, (s.contracts.get(ev.contractId) ?? 0) + 1)
        const name = eventName(ev.topic[0]) ?? "unknown"
        s.actions.set(name, (s.actions.get(name) ?? 0) + 1)
        for (const t of ev.topic.slice(1)) {
          const key = accountKey(t)
          if (key) s.wallets.add(key)
        }
      }
      log(`  contracts ${g + 1}-${g + group.length}: +${page.events.length} events`)
      const last = page.events.at(-1)
      if (page.events.length < PAGE_LIMIT || last.ledger > endLedger || Date.parse(last.ledgerClosedAt) >= end) break
      cursor = page.cursor
    }
  }

  return {
    day,
    ledgerFrom: Number.isFinite(firstLedger) ? firstLedger : null,
    ledgerTo: lastLedger || null,
    rpc: rpcUrl,
    protocols: [...perProtocol].map(([protocol, s]) => ({
      protocol,
      events: s.events,
      wallets: s.wallets.size,
      activeContracts: s.contracts.size,
      byAction: Object.fromEntries([...s.actions].sort((a, b) => b[1] - a[1])),
      byContract: Object.fromEntries([...s.contracts].sort((a, b) => b[1] - a[1])),
    })),
  }
}
