# FastLocal

**When the local stops, FastLocal pays.**

Instant disruption cover for Mumbai local train commuters. Tap once to protect your ride. If your station stops (rain flooding, signal, power or track fault), an autonomous agent pays you on Monad. You never file a claim.

## Live links

| | |
|---|---|
| Live app | https://web-amber-seven-021mzgehda.vercel.app (phone page `/`, operator screen [`/screen`](https://web-amber-seven-021mzgehda.vercel.app/screen)) |
| Testnet contract | [`0xB3b7ca84934aB1F2655179349452E9183e5D4C60`](https://testnet.monadvision.com/address/0xB3b7ca84934aB1F2655179349452E9183e5D4C60) on Monad Testnet (chain 10143), **verified** (Sourcify), deploy block 63835612 |
| Mainnet contract | _TODO: address_ on Monad Mainnet (chain 143), sales closed, verified: _TODO: link_ |
| Demo video | _TODO: link_ |
| Repo | https://github.com/SudoMayo/FastLocal |

## Problem

- Mumbai suburban rail carries millions of riders a day, and service stops often: rain flooding in the monsoon; signal failures, power failures and track faults all year.
- A stopped train means an expensive auto or cab, or a lost day of wages.
- Insurance cannot handle a Rs 300 claim. The paperwork costs more than the claim, and payment takes days. Relief is needed on the platform, now.

## How it works

1. **Scan and open.** The commuter scans a QR code. No app, no wallet extension. The site creates a demo (burner) wallet in the browser, and the server drips a little gas to it.
2. **Protect my ride.** Pick a station and tap once. The pass is bought on chain. Price is dynamic: CLEAR = base (Rs 10), ALERT (high risk, e.g. heavy rain) = 2x, DISRUPTED = sales closed.
3. **Disruption.** The oracle marks the station DISRUPTED with a cause (stored on chain).
4. **Autonomous payout.** The agent sees DISRUPTED + unpaid passes and pushes payouts. No human in the payout path.
5. **Relief lands.** The phone turns green: "Rs 300 relief received", with the transaction link.

## Disruption model

| Status | Meaning |
|---|---|
| `CLEAR` | Normal service. Base price. |
| `ALERT` | High risk. Price is 2x. Needs a cause. |
| `DISRUPTED` | Service stopped. Sales closed. Eligible passes get paid. Needs a cause. |

Causes: `RAIN_FLOOD`, `SIGNAL_FAILURE`, `POWER_FAILURE`, `TRACK_FAULT`, `OTHER`. Every cause pays the same fixed relief. **Rain is the core case**: monsoon flooding is the most common, most predictable stop. The other causes make it a year-round product.

## Autonomous agent

`web/scripts/agent.ts` (`npm run agent`) is a state-driven loop that runs every 2 s:

1. Read all station statuses. For each DISRUPTED station, read the buyer snapshot (pages of 200).
2. If any pass is eligible (active, unpaid, not expired, waiting period passed), run the payout engine (`web/lib/server/payout-engine.ts`):
   - **Burst:** read the nonce, gas and fees once, then send `payout(addr)` for each buyer with explicit nonces in concurrent groups of 10.
   - **Confirm:** wait for receipts (30 s timeout).
   - **Retry:** anything unpaid is retried once with `payoutBatch` in chunks of 25. After a timeout, it re-syncs the nonce from chain.
3. Log: `[agent] Dadar DISRUPTED (Rain flooding): 21 eligible -> paid 21, blocks 63850784..63850791`

Safety:
- **Restart-safe:** all state lives on chain, and the contract refuses double payouts.
- **One bad cycle never stops the loop.** In our test the laptop lost DNS mid-run, and the agent kept going and paid the rest when the network came back.
- **Low gas:** the agent warns every cycle when its gas is low.
- **Fallback:** the operator's "Run payouts now" button calls `/api/admin/payout`, which uses a *different* key and `payoutBatch` only. `payoutBatch` skips already-paid entries, so the worker and the fallback can race safely.

## Why Monad

Parametric cover only works if hundreds of tiny payouts land fast and cheap, right when the train stops. On Monad Testnet we measured:

| What | Result |
|---|---|
| Autonomous agent, Dadar, 21 passes | 21 of 21 paid, all in blocks 63850784..63850791 (8 blocks). From the disruption block to the last payout: **24 blocks (7 s)**, including the agent's 2 s polling. |
| Fallback `payoutBatch`, Kurla, 3 passes | 3 of 3 paid in one tx, **12 blocks (3 s)** after the disruption block. |
| `buyPass` | 185,032 gas limit (207,308 for the first buyer at a station), about 0.019 to 0.021 MON at 102 to 103 gwei |
| `payout` | 108,002 gas limit, about 0.011 MON |
| `payoutBatch` (10 addresses) | 486,501 gas limit, about 0.005 MON per payout |

Seconds come from block timestamps, which have 1 s resolution. Gas limits are estimate x 1.3. Monad charges the full gas limit, so every write sets an explicit limit.

## Architecture

```
 Phone (browser)                         Operator screen (/screen)
 burner wallet in localStorage           passcode, station + cause controls,
 buyPass signed in the browser           QR, live counts, health, speed proof
      |          \                              |
      | reads     \ POST /api/drip              | POST /api/admin/station  (oracle key)
      | (1 multicall  \                         | POST /api/admin/payout   (AGENT_SERVER key, payoutBatch)
      |  per poll)     v                        v
      |      +------------------ Next.js on Vercel ------------------+
      |      | /api/drip    relayer key: gas for fresh wallets only  |
      |      | /api/health  balances of vault, relayer, agents        |
      |      +--------------------------+----------------------------+
      v                                 v
 +-------------------------- Monad (FastLocalCore.sol) --------------------------+
 | stations: status + cause | policies (1 slot each) | buyers per station | vault |
 +-------------------------------------------------------------------------------+
      ^
      | reads statuses + snapshots every 2 s, sends payout() bursts
 Autonomous agent worker (npm run agent, AGENT_WORKER key, runs on the operator's machine)
```

Keys: DEPLOYER = owner + oracle, RELAYER = gas drips, AGENT_WORKER = worker payouts, AGENT_SERVER = fallback payouts. All keys stay server-side or on the worker machine.

## Contract: `contracts/src/FastLocalCore.sol`

| Function | Who | What |
|---|---|---|
| `buyPass(uint8 id)` payable | anyone | Buy a 1-day pass at a station. Needs the exact `premiumFor(id)` and no active unpaid pass. |
| `premiumFor(uint8 id)` view | anyone | CLEAR = base, ALERT = 2x, DISRUPTED reverts "Sales closed". |
| `setStation(uint8 id, Status, Cause)` | oracle | CLEAR forces cause NONE. ALERT/DISRUPTED need a cause. The first DISRUPTED sets `disruptedAtBlock`. |
| `payout(address)` | agent | Pays one eligible pass. Effects before transfer. |
| `payoutBatch(address[])` | agent | Pays every eligible address and skips the rest. A failed transfer restores that pass and emits `PayoutFailed`. |
| `isEligible(address)` view | anyone | Active, unpaid, not expired, waiting period passed, station DISRUPTED. |
| `getAllStatuses()` view | anyone | Status and cause of all 6 stations. |
| `buyerCount(id)`, `getSnapshot(id, offset, limit)` view | anyone | Paginated buyers + policies. |
| `vaultCoverage()` view | anyone | Vault balance / payout amount. |
| `setAgent`, `setOracle`, `setPremium`, `setPayout`, `setSalesOpen`, `setWaitingPeriod`, `withdraw` | owner | Admin. |
| `receive()` | anyone | Funds the vault. |

Defaults: base premium 0.001 MON (Rs 10), payout 0.03 MON (Rs 300), waiting period 0, 6 stations (CSMT, Dadar, Kurla, Sion, Andheri, Thane). Display rate: 0.0001 MON = Rs 1 (demo rate).

## Run locally

### Prerequisites

| Tool | Version we used |
|---|---|
| Node.js | 22.22 (20 or newer) |
| npm | 10.9 |
| Foundry (forge, cast) | 1.8.3 (Monad docs need 1.8 or newer). Install: `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| git | any |

### 1. Clone

```bash
git clone https://github.com/SudoMayo/FastLocal.git
cd FastLocal
```

### 2. Wallets

Create 4 wallets. `cast wallet new` prints the address and private key; save them somewhere safe (for example `.secrets/wallets.env`, which is gitignored). Never commit keys.

```bash
cast wallet new   # DEPLOYER (owner + oracle)
cast wallet new   # RELAYER (gas drips)
cast wallet new   # AGENT_WORKER (autonomous agent)
cast wallet new   # AGENT_SERVER (fallback payout route)
```

Get testnet MON for DEPLOYER from https://faucet.monad.xyz.

### 3. Contracts: build, test, deploy, verify

```bash
cd contracts
cp .env.example .env    # fill it in, see the table below
forge build
forge test              # 27 tests
set -a; source .env; set +a
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 130
```

The script deploys, registers both agents and funds the vault with `VAULT_FUND_MON`. It prints the contract address and deploy block. Then verify:

```bash
forge verify-contract <CONTRACT_ADDRESS> src/FastLocalCore.sol:FastLocalCore --chain 10143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

`contracts/.env`:

| Variable | Secret | Example | Meaning |
|---|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | yes | `0x…` | Owner + oracle |
| `AGENT_WORKER_ADDRESS` | no | `0x…` | Registered as agent |
| `AGENT_SERVER_ADDRESS` | no | `0x…` | Registered as agent |
| `VAULT_FUND_MON` | no | `3` | MON sent to the payout vault at deploy (`0` on mainnet) |

If you change the contract, regenerate the ABI in `web/lib/abi.ts` with `forge inspect FastLocalCore abi --json`.

### 4. Fund the relayer and agents

Monad has a **reserve balance rule**: a wallet cannot *send value* that takes it below 10 MON (paying gas is fine). The relayer sends value on every drip, so **only its balance above 10 MON is usable**. Agents only pay gas, because payouts come from the contract.

```bash
RPC=https://testnet-rpc.monad.xyz
cast send <RELAYER_ADDRESS>      --value 14ether  --gas-limit 21000 --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RPC  # 10 reserve + ~60 drips
cast send <AGENT_WORKER_ADDRESS> --value 3ether   --gas-limit 21000 --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RPC  # ~0.011 MON per payout
cast send <AGENT_SERVER_ADDRESS> --value 1.5ether --gas-limit 21000 --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $RPC  # ~0.005 MON per batch payout
```

Recommended minimums: relayer 10 MON + 0.065 x expected drips; worker 1.5 MON; fallback 0.5 MON; deployer 10.5 MON.

### 5. Web app

```bash
cd ../web
cp .env.example .env.local   # fill it in, see the table below
npm install
npm run dev                  # http://localhost:3000 (phone), http://localhost:3000/screen (operator)
```

`web/.env.local`:

| Variable | Used by | Secret | Example |
|---|---|---|---|
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | browser | no | `0xB3b7…4C60` |
| `NEXT_PUBLIC_RPC_URL` | browser | no | `https://testnet-rpc.monad.xyz` |
| `NEXT_PUBLIC_EXPLORER_URL` | browser | no | `https://testnet.monadvision.com` |
| `NEXT_PUBLIC_CHAIN_ID` | browser | no | `10143` |
| `NEXT_PUBLIC_DEPLOY_BLOCK` | browser | no | `63835612` |
| `RPC_URL` | server | no (yes if it is a private RPC) | `https://testnet-rpc.monad.xyz` |
| `ORACLE_PRIVATE_KEY` | server | **yes** | DEPLOYER key |
| `RELAYER_PRIVATE_KEY` | server | **yes** | RELAYER key |
| `AGENT_SERVER_PRIVATE_KEY` | server | **yes** | AGENT_SERVER key |
| `AGENT_WORKER_ADDRESS` | server | no | shown on the health panel |
| `ADMIN_PASSCODE` | server | **yes** | random 16 characters |
| `DRIP_AMOUNT_MON` | server | no | `0.065` (measured buyPass gas cost x 3 + premium) |

Worker-only variables (same file, used by `npm run agent`; never put them on Vercel):

| Variable | Secret | Example |
|---|---|---|
| `AGENT_WORKER_PRIVATE_KEY` | **yes** | AGENT_WORKER key |
| `CONTRACT_ADDRESS` | no | same as `NEXT_PUBLIC_CONTRACT_ADDRESS` |
| `ORACLE_MODE` | no | `manual` |
| `ALERT_MM`, `CLEAR_MM` | no | reserved for the auto rain oracle (not in this build) |

### 6. Start the agent

```bash
npm run agent
# 09:48:29 [agent] starting. agent 0xcB29…, contract 0xB3b7…, rpc testnet-rpc.monad.xyz
```

### 7. Trigger a disruption

Open `/screen`, enter `ADMIN_PASSCODE`, pick a station and a cause, and press **DISRUPT**. Or with cast (status 2 = DISRUPTED, cause 1 = RAIN_FLOOD):

```bash
cast send <CONTRACT_ADDRESS> "setStation(uint8,uint8,uint8)" 1 2 1 --gas-limit 160000 \
  --private-key $DEPLOYER_PRIVATE_KEY --rpc-url https://testnet-rpc.monad.xyz
```

Press **CLEAR** to reset. The screen blocks CLEAR while eligible passes are still unpaid, unless you tick Force.

### 8. Seed load test

```bash
npm run seed -- --count 20 --station 1   # 20 fresh wallets buy passes at Dadar (funded by the relayer)
```

Build check: `npm run build` (zero errors, zero type errors) and `npx eslint app lib scripts`.

## Deploy your own on Vercel

1. Import the GitHub repo on vercel.com. Set **Root Directory** to `web`. The framework is detected as Next.js.
2. Add every variable from the `web/.env.local` table **except** the worker-only ones. Mark the private keys and `ADMIN_PASSCODE` as sensitive.
3. Deploy. Open `/` on a phone and `/screen` on the projector.
4. Run the agent (`npm run agent`) on the operator's machine. It is a long-running loop, so it does not run on Vercel. The screen's "Run payouts now" button is the serverless fallback.

**If the contract is redeployed:** update `NEXT_PUBLIC_CONTRACT_ADDRESS` and `NEXT_PUBLIC_DEPLOY_BLOCK` on Vercel and redeploy, update `CONTRACT_ADDRESS` for the worker, and update this README.

## Business model and pre-market fit

- **Pre-market fit:** _TODO: venue survey results (n = ?, % who lost money to a train stop, % who would pay Rs 10)._ Real passes bought on testnet today: _TODO: count from the screen._
- **Revenue:** premium pool with a target loss ratio; B2B cover for employers and gig platforms; sponsored relief pools (brand-funded free passes); disruption data.
- **Year-round:** rain in the monsoon; signal, power and track faults all year.
- **Go-to-market:** 3 high-disruption stations, 1 employer partner, and a licensed insurance partner or a sponsored-relief model.
- **Expansion:** more Mumbai stations, then metro and suburban networks in other cities.

## Edge cases handled

- **Sales closed:** a station that is already DISRUPTED shows "Sales closed at {station}", and the contract reverts the buy.
- **Buying during ALERT:** the price is 2x, and the phone reads `premiumFor` right before sending. If the price changes in between, the tx reverts and the phone asks for one more tap.
- **Double tap or two tabs:** the second buy reverts ("Active policy") and the phone shows the protected state.
- **Reload during the drip:** the drip API re-checks balance and nonce, and the burner key persists in localStorage.
- **Cleared localStorage:** you get a new wallet. The old pass stays on chain, and the UI always labels it a "demo wallet".
- **Disruption at another station:** your pass is not paid and stays protected.
- **Expired pass:** not paid. You can buy again, and a paid user can buy a new pass.
- **Vault too low:** the engine reports failures and the health panel warns. After the vault is funded, the next cycle pays.
- **Relayer at or below the reserve:** the drip API returns a clear error and the health panel warns. **Agent gas low:** the worker warns every cycle.
- **Worker down:** "Run payouts now" is the fallback. Worker and fallback at the same time is safe: `payoutBatch` skips already-paid entries.
- **Stuck tx or timeout:** the engine re-syncs the nonce, bumps fees and retries with `payoutBatch`.
- **Recipient rejects payment:** `payoutBatch` restores that pass, emits `PayoutFailed` and continues.
- **Early CLEAR:** blocked on the screen and on the server while eligible passes are unpaid, unless forced.
- **RPC errors:** phone and screen back off and retry. Phone reads are merged into one multicall per poll.

## Limitations and next steps

- **Single oracle operator** in this version. Next: a quorum of rail service status, rainfall data and verified commuter reports.
- **Testnet MON at a demo rate.** Next: stablecoin payouts and a UPI off-ramp.
- **No coverage cap per station yet.** Next: cap passes per station by vault size.
- **Burner wallets are demo wallets.**
- **Rate limits are in-memory** per server instance.
- **The agent runs on one machine.**

## Team

_TODO: names and roles._ Built at Monad Blitz Mumbai V4.
