// Fails (exit 1) when the publisher wallet is running low on test GLM, so the
// daily workflow fails and GitHub emails the repo owner to top it up.
//
//   node src/check-balance.js            # minimum 1 GLM
//   MIN_GLM=0.5 node src/check-balance.js

import { formatEther, parseEther } from "viem"
import { publicClient } from "./arkiv.js"
import { PUBLISHER } from "./schema.js"

const min = parseEther(process.env.MIN_GLM || "1")
const balance = await publicClient().getBalance({ address: PUBLISHER })

console.log(`publisher ${PUBLISHER}: ${formatEther(balance)} GLM (minimum ${formatEther(min)})`)
if (balance < min) {
  console.error(`Balance is low. Top it up at https://hub.arkiv.network/faucet`)
  process.exit(1)
}
