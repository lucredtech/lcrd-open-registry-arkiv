import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "https://esm.sh/@arkiv-network/sdk@0.8.1?target=es2022&bundle-deps"
import { i32, str, u64 } from "https://esm.sh/@arkiv-network/sdk@0.8.1/attr?target=es2022&bundle-deps"
import { eq } from "https://esm.sh/@arkiv-network/sdk@0.8.1/query?target=es2022&bundle-deps"
import { tiramisu } from "https://esm.sh/@arkiv-network/sdk@0.8.1/chains?target=es2022&bundle-deps"
import { custom, http, webSocket } from "https://esm.sh/viem@2.57.5?target=es2022"
import { APP, GROUPS, LIFETIME_DAYS, PUBLISHER, SCHEMA_VERSION, TYPES, stellarExpertContractUrl } from "../src/schema.js"

const SECONDS_PER_BLOCK = 2
const EXPLORER = "https://tiramisu.explorer.arkiv.network"

// No retries: on a 429 viem would silently wait out Retry-After (often 20+ minutes).
const reader = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 0, timeout: 30_000 }) })

const $ = (id) => document.getElementById(id)
const short = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s ?? "")
const fmt = (n) => Number(n).toLocaleString("en")
const value = (e, name) => e.attributes?.[name]?.value
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const sameAddr = (a, b) => a && b && a.toLowerCase() === b.toLowerCase()

const state = { contracts: [], protocols: [], days: [], claims: [], group: "all", search: "", day: null, block: 0n, fresh: new Set() }

// Each Arkiv query costs a visitor's anonymous quota, so the page runs two:
// everything the publisher wrote for this app (split by type on the client),
// and every community claim.
async function fetchAll(extra, creator) {
  let q = reader
    .select({ key: true, attributes: true, payload: true, contentType: true, creator: true, expiresAt: true })
    .where(eq("app", str(APP)), ...extra)
    .limit(200)
  if (creator) q = q.createdBy(creator)
  let page = await q.fetch()
  state.block = page.blockNumber ?? state.block
  const out = [...page.entities]
  while (page.hasNextPage()) {
    page = await page.next()
    out.push(...page.entities)
  }
  return out
}

function toast(msg) {
  const t = $("toast")
  t.textContent = msg
  t.classList.add("show")
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove("show"), 3500)
}

// ---- loading -------------------------------------------------------------

async function loadPublished() {
  const all = await fetchAll([], PUBLISHER)
  const of = (type) => all.filter((e) => value(e, "type") === type)
  state.contracts = of(TYPES.contract)
  state.protocols = of(TYPES.protocol)
  state.days = of(TYPES.protocolDay)
}

async function loadClaims() {
  state.claims = await fetchAll([eq("type", str(TYPES.claim))])
}

const loadAll = () => Promise.all([loadPublished(), loadClaims()])

// The fallback when this visitor's anonymous Arkiv reads are rate-limited:
// a snapshot the daily job reads from Arkiv with an API key and publishes
// next to the page. Shaped like live query results so rendering is shared.
async function loadSnapshot() {
  const res = await fetch("../snapshot.json", { cache: "no-cache" })
  if (!res.ok) throw new Error(`snapshot: HTTP ${res.status}`)
  const snap = await res.json()
  const typed = (a) => ({ type: a.type, value: a.type === "i32" ? Number(a.value) : ["u64", "u256"].includes(a.type) ? BigInt(a.value) : a.value })
  const all = snap.entities.map((e) => ({
    key: e.key,
    creator: e.creator,
    expiresAt: BigInt(e.expiresAt),
    attributes: Object.fromEntries(Object.entries(e.attributes).map(([k, a]) => [k, typed(a)])),
    toJson: () => e.payload,
  }))
  const curated = all.filter((e) => sameAddr(e.creator, PUBLISHER))
  const of = (type) => curated.filter((e) => value(e, "type") === type)
  state.contracts = of(TYPES.contract)
  state.protocols = of(TYPES.protocol)
  state.days = of(TYPES.protocolDay)
  state.claims = all.filter((e) => value(e, "type") === TYPES.claim)
  state.block = BigInt(snap.block)
  return snap
}

function showNotice(html) {
  $("notice").innerHTML = html
  $("notice").hidden = false
}

// ---- rendering -----------------------------------------------------------

function renderStats() {
  $("s-protocols").textContent = fmt(state.protocols.length)
  $("s-contracts").textContent = fmt(state.contracts.length)
  const latest = state.day ?? Math.max(0, ...state.days.map((e) => value(e, "day")))
  const events = state.days.filter((e) => value(e, "day") === latest).reduce((s, e) => s + Number(value(e, "events")), 0)
  $("s-events").textContent = latest ? fmt(events) : "–"
  $("s-day").textContent = latest ? dayLabel(latest) : "–"
  $("s-block").textContent = state.block ? fmt(state.block) : "–"
}

function dayLabel(d) {
  const iso = `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, "0")}-${String(d % 100).padStart(2, "0")}`
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })
}

function renderDaySelect() {
  const days = [...new Set(state.days.map((e) => value(e, "day")))].sort((a, b) => b - a)
  if (!days.includes(state.day)) state.day = days[0] ?? null
  $("day-select").innerHTML = days.map((d) => `<option value="${d}" ${d === state.day ? "selected" : ""}>${dayLabel(d)} (UTC)</option>`).join("")
  $("day-select").hidden = days.length === 0
}

function sparkline(protocol, days) {
  const series = days.map((d) => {
    const e = state.days.find((x) => value(x, "day") === d && value(x, "protocol") === protocol)
    return e ? Number(value(e, "events")) : 0
  })
  const max = Math.max(1, ...series)
  const w = 6, gap = 2, h = 22
  const bars = series
    .map((v, i) => {
      const bh = v ? Math.max(2, Math.round((v / max) * h)) : 0
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1"><title>${dayLabel(days[i])}: ${fmt(v)}</title></rect>`
    })
    .join("")
  return `<svg class="spark" width="${days.length * (w + gap)}" height="${h}" aria-label="${protocol} events, last ${days.length} days">${bars}</svg>`
}

function renderActivity() {
  const body = $("activity").querySelector("tbody")
  const rows = state.days.filter((e) => value(e, "day") === state.day).sort((a, b) => Number(value(b, "events") - value(a, "events")))
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No activity published yet.</td></tr>`
    return
  }
  const allDays = [...new Set(state.days.map((e) => value(e, "day")))].sort((a, b) => a - b).slice(-14)
  body.innerHTML = rows
    .map((e) => {
      const p = e.toJson()
      const top = Object.entries(p.byAction ?? {}).slice(0, 3).map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(" · ")
      return `<tr class="${state.fresh.has(e.key) ? "new" : ""}">
        <td><strong>${esc(value(e, "protocol"))}</strong></td>
        <td class="num">${fmt(value(e, "events"))}</td>
        <td class="num">${fmt(value(e, "wallets"))}</td>
        <td class="num">${fmt(value(e, "active_contracts"))}</td>
        <td class="actions">${top}</td>
        <td>${sparkline(value(e, "protocol"), allDays)}</td>
      </tr>`
    })
    .join("")
}

function renderGroups() {
  const counts = { all: state.contracts.length }
  for (const e of state.contracts) counts[value(e, "group")] = (counts[value(e, "group")] ?? 0) + 1
  const groups = ["all", ...Object.keys(GROUPS)].filter((g) => counts[g])
  $("groups").innerHTML = groups
    .map((g) => `<button class="chip" data-group="${g}" aria-pressed="${g === state.group}">${g} <span>${counts[g]}</span></button>`)
    .join("")
}

function renderContracts() {
  const q = state.search.trim().toLowerCase()
  const rows = state.contracts
    .filter((e) => state.group === "all" || value(e, "group") === state.group)
    .filter((e) => !q || ["contract", "protocol", "category", "asset"].some((k) => String(value(e, k) ?? "").toLowerCase().includes(q)))
    .sort((a, b) => value(a, "protocol").localeCompare(value(b, "protocol")) || value(a, "category").localeCompare(value(b, "category")))
  const body = $("contracts").querySelector("tbody")
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${state.contracts.length ? "No match." : "Nothing published yet."}</td></tr>`
    return
  }
  body.innerHTML = rows
    .map((e) => {
      const id = value(e, "contract")
      return `<tr class="${state.fresh.has(e.key) ? "new" : ""}">
        <td class="mono"><a href="${stellarExpertContractUrl(id)}" target="_blank" rel="noopener" title="${id}">${short(id, 8, 6)}</a></td>
        <td>${esc(value(e, "protocol"))}</td>
        <td><span class="tag">${esc(value(e, "category"))}</span></td>
        <td>${esc(value(e, "asset") ?? "")}</td>
        <td class="mono" title="${e.key}">${short(e.key, 8, 6)}</td>
      </tr>`
    })
    .join("")
}

function renderClaims() {
  const curated = new Set(state.contracts.map((e) => value(e, "contract")))
  const body = $("claims").querySelector("tbody")
  if (!state.claims.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No submissions waiting.</td></tr>`
    return
  }
  body.innerHTML = state.claims
    .map((e) => {
      const id = value(e, "contract")
      const left = Number(e.expiresAt - state.block) * SECONDS_PER_BLOCK
      const status = curated.has(id)
        ? `<span class="tag ok">in registry</span>`
        : `<span class="tag warn">unverified · ${Math.max(0, Math.round(left / 86400))}d left</span>`
      return `<tr class="${state.fresh.has(e.key) ? "new" : ""}">
        <td class="mono"><a href="${stellarExpertContractUrl(id)}" target="_blank" rel="noopener" title="${esc(id)}">${short(id, 8, 6)}</a></td>
        <td>${esc(value(e, "protocol"))}</td>
        <td>${esc(value(e, "category"))}</td>
        <td class="mono"><a href="${EXPLORER}/address/${e.creator}" target="_blank" rel="noopener">${short(e.creator)}</a></td>
        <td>${status}</td>
      </tr>`
    })
    .join("")
}

function renderSnippet() {
  $("snippet").textContent = `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { str } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { http } from "viem"

const client = createPublicClient({ chain: tiramisu, transport: http() })

const page = await client
  .select({ key: true, attributes: true, payload: true })
  .where(eq("app", str("${APP}")), eq("type", str("contract")), eq("group", str("lending")))
  .createdBy("${PUBLISHER}")   // curated entries only
  .limit(200)
  .fetch()

for (const e of page.entities) console.log(e.toJson())`
}

function renderAll() {
  renderStats()
  renderDaySelect()
  renderActivity()
  renderGroups()
  renderContracts()
  renderClaims()
}

// ---- live updates --------------------------------------------------------

function startLive() {
  const live = $("live")
  let client
  try {
    client = createPublicClient({ chain: tiramisu, transport: webSocket() })
  } catch {
    $("live-text").textContent = "live updates off"
    return
  }
  // Tiramisu is shared with every other app, and each query costs quota, so
  // only react to the publisher's writes and to entities already on the page.
  // The event's indexed owner makes that check free. Bursts (a publisher run
  // writes in batches) collapse into one reload.
  const known = () => new Set([...state.contracts, ...state.protocols, ...state.days, ...state.claims].map((e) => e.key))
  let pending
  let burst = 0
  client.watchEntityEvents({
    onEvent: (event) => {
      if (!sameAddr(event.owner, PUBLISHER) && !known().has(event.entityKey)) return
      state.fresh.add(event.entityKey)
      burst++
      live.classList.add("flash")
      setTimeout(() => live.classList.remove("flash"), 800)
      clearTimeout(pending)
      pending = setTimeout(async () => {
        const n = burst
        burst = 0
        try {
          await loadAll()
          renderAll()
          $("notice").hidden = true
          $("live").classList.add("on")
          $("live-text").textContent = "live from Arkiv"
          toast(`${n} update${n === 1 ? "" : "s"} from the publisher, live from Arkiv`)
        } catch {
          toast("Live update received, but Arkiv is rate-limiting reads right now.")
        }
      }, 3000)
    },
    onError: () => {
      live.classList.remove("on")
      $("live-text").textContent = "live updates paused"
    },
  })
  live.classList.add("on")
  $("live-text").textContent = "live from Arkiv"
}

// ---- community submissions ----------------------------------------------

async function connectWallet() {
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or another EVM wallet.")
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" })
  const chainId = `0x${tiramisu.id.toString(16)}`
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
  } catch (err) {
    if (err.code !== 4902) throw err
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: tiramisu.name,
        nativeCurrency: tiramisu.nativeCurrency,
        rpcUrls: tiramisu.rpcUrls.default.http,
        blockExplorerUrls: [EXPLORER],
      }],
    })
  }
  return createWalletClient({ chain: tiramisu, transport: custom(window.ethereum), account })
}

async function submitClaim(ev) {
  ev.preventDefault()
  const form = ev.target
  const data = Object.fromEntries(new FormData(form))
  const btn = $("claim-btn")
  const msg = $("claim-msg")
  btn.disabled = true
  try {
    if (state.contracts.some((e) => value(e, "contract") === data.contract)) {
      throw new Error("That contract is already in the registry.")
    }
    msg.textContent = "Waiting for your wallet…"
    const wallet = await connectWallet()
    const { entityKey, txHash } = await wallet.createEntity({
      attributes: {
        app: str(APP),
        type: str(TYPES.claim),
        schema: i32(SCHEMA_VERSION),
        contract: str(data.contract),
        protocol: str(data.protocol),
        category: str(data.category),
        submitted_at: u64(BigInt(Date.now())),
      },
      payload: jsonToPayload({ contractId: data.contract, protocol: data.protocol, category: data.category, note: data.note || null }),
      contentType: "application/json",
      expires: ExpirationTime.fromDays(LIFETIME_DAYS.claim),
    })
    state.fresh.add(entityKey)
    msg.innerHTML = `Submitted. <a href="${EXPLORER}/tx/${txHash}" target="_blank" rel="noopener">View transaction</a>`
    form.reset()
    await loadClaims()
    renderClaims()
  } catch (err) {
    msg.textContent = err.shortMessage ?? err.message ?? String(err)
  } finally {
    btn.disabled = false
  }
}

// ---- wiring --------------------------------------------------------------

function wire() {
  $("publisher").textContent = PUBLISHER
  $("publisher").href = `${EXPLORER}/address/${PUBLISHER}`
  $("claim-form").category.innerHTML = Object.values(GROUPS).flat().map((c) => `<option>${c}</option>`).join("")
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value
    renderContracts()
  })
  $("groups").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-group]")
    if (!chip) return
    state.group = chip.dataset.group
    renderGroups()
    renderContracts()
  })
  $("day-select").addEventListener("change", (e) => {
    state.day = Number(e.target.value)
    renderStats()
    renderActivity()
  })
  $("claim-form").addEventListener("submit", submitClaim)
}

wire()
renderSnippet()
loadAll()
  .then(renderAll)
  .catch(async (err) => {
    console.error(err)
    const limited = String(err?.status ?? err?.cause?.status ?? err?.message).includes("429")
    try {
      const snap = await loadSnapshot()
      renderAll()
      $("live").classList.remove("on")
      $("live-text").textContent = "snapshot"
      const when = new Date(snap.takenAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
      showNotice(
        `${limited ? "Arkiv's public RPC is rate-limiting anonymous reads from your network right now" : "Could not read Arkiv directly right now"}, ` +
          `so this is the <a href="../snapshot.json" target="_blank" rel="noopener">snapshot</a> read from Arkiv at block ${fmt(snap.block)} (${when} UTC). ` +
          `Every entity key and creator here can be checked on the <a href="${EXPLORER}/address/${PUBLISHER}" target="_blank" rel="noopener">explorer</a>. Reload later for live data.`,
      )
    } catch (snapErr) {
      console.error(snapErr)
      const msg = limited
        ? "The public Arkiv RPC has rate-limited this network for a few minutes. Please try again shortly."
        : "Could not reach Arkiv. Please reload in a moment."
      for (const id of ["activity", "contracts", "claims"]) {
        const cols = $(id).querySelectorAll("thead th").length
        $(id).querySelector("tbody").innerHTML = `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`
      }
    }
  })
startLive()
