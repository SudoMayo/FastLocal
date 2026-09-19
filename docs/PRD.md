# FastLocal PRD

## 1. One line
FastLocal is instant disruption cover for local train commuters. Tap once to protect
your ride. If your train stops, an autonomous agent pays you. You never file a claim.
Tagline: "When the local stops, FastLocal pays."

## 2. Problem
- Mumbai suburban rail carries millions of riders every day. Service stops often:
  rain flooding in the monsoon, and signal failures, power failures, and track faults
  all year.
- A stopped train means an expensive auto or cab, or a lost day of wages.
- Traditional insurance cannot handle a Rs 300 claim. Paperwork costs more than the
  claim, and payment takes days. Relief is needed on the platform, immediately.

## 3. Users
- Primary: daily commuters and gig workers.
- Buyer (later): employers and gig platforms that buy cover for their workers.

## 4. Solution and user flow
1. Commuter scans a QR code or opens the site. No app, no wallet extension.
2. The site creates a burner wallet in the browser. The server sends a small gas drip.
3. Commuter picks a station and taps "Protect My Ride". The pass is bought on chain.
4. Price is dynamic: CLEAR = base price. ALERT (risk is high, for example heavy rain)
   = 2x. DISRUPTED = sales closed.
5. The oracle marks the station DISRUPTED with a cause.
6. The autonomous agent sees DISRUPTED + unpaid policies and pushes payouts.
   No human action in the payout path.
7. The commuter's screen turns green: "Rs 300 relief received", with the tx link.

## 5. Disruption model
- Status: CLEAR, ALERT, DISRUPTED.
- Cause: NONE, RAIN_FLOOD, SIGNAL_FAILURE, POWER_FAILURE, TRACK_FAULT, OTHER.
- Every cause pays the same fixed relief. The cause is stored on chain and shown in the UI.
- Rain is the core feature: in auto mode, live rainfall sets ALERT pricing (P1).

## 6. Scope
P0 (must ship; announce only these):
- FastLocalCore.sol on Monad Testnet, verified.
- Burner wallet + drip API.
- Phone page: buy pass, protected state, auto-detected payout.
- Autonomous agent worker (state-driven loop) + serverless fallback payout route.
- Operator screen: station controls with cause, QR, live counts, health panel,
  on-chain speed proof.
- README a stranger can follow. Hosted on Vercel.
- Same contract deployed on Monad Mainnet with sales closed, verified.
P1 (only after P0 passes the E2E test):
- Auto rain oracle: Open-Meteo rainfall sets ALERT / CLEAR with cause RAIN_FLOOD.
  It never sets DISRUPTED and never overrides an operator status.
- Seed script for load tests. Haptic buzz on payout.
Cut: real sensors, LLM, LP tokens, governance, account abstraction, UPI off-ramp
(next step only), detailed multi-line map.

## 7. Autonomous agent design
- Worker: web/scripts/agent.ts, run with `npm run agent`. Loop every 2 s:
  read all statuses; for each DISRUPTED station, read the snapshot; if any policy is
  eligible (active, not paid, not expired, waiting period passed), run the engine.
- State-driven: restart-safe. The contract blocks double payouts.
- Per-station in-flight lock. One failed cycle never stops the loop.
- Engine: web/lib/server/payout-engine.ts.
  1. Collect eligible addresses (snapshot pages of 200), dedupe.
  2. Burst: pending nonce once, gas estimate once (x1.3), send payout(addr) for each
     with explicit incrementing nonces, in concurrent groups of 10.
  3. Wait for receipts (timeout 30 s). On timeout, re-sync nonce from chain.
  4. Retry failures once with payoutBatch in chunks of 25.
  5. Return { paid, failed, txHashes, firstBlock, lastBlock }.
- Fallback: /api/admin/payout uses a different key (AGENT_SERVER) and calls
  payoutBatch only. payoutBatch skips already-paid entries, so a race with the
  worker is safe.
- Auto rain oracle (P1): worker polls Open-Meteo current precipitation per station
  every 60 s with the oracle key. CLEAR -> ALERT(RAIN_FLOOD) at >= ALERT_MM.
  ALERT(RAIN_FLOOD) -> CLEAR below CLEAR_MM. It changes nothing else.

## 8. Contract: contracts/src/FastLocalCore.sol (Solidity ^0.8.24)
State:
- enum Status { CLEAR, ALERT, DISRUPTED }
- enum Cause { NONE, RAIN_FLOOD, SIGNAL_FAILURE, POWER_FAILURE, TRACK_FAULT, OTHER }
- struct Policy { uint8 stationId; uint64 boughtAt; uint64 expiry; uint64 paidBlock;
  bool active; bool paid; }   (fits one storage slot)
- mapping(uint8 => Status) stationStatus; mapping(uint8 => Cause) stationCause
- mapping(uint8 => uint64) disruptedAtBlock
- mapping(uint8 => address[]) buyers
- mapping(address => Policy) policies
- owner, oracle, mapping(address => bool) isAgent
- basePremium, payoutAmount, waitingPeriod (default 0), bool salesOpen (default true)
- uint8 constant STATION_COUNT = 6; simple nonReentrant lock
Functions:
- premiumFor(id): CLEAR base, ALERT 2x, DISRUPTED revert "Sales closed".
- buyPass(id) payable nonReentrant: salesOpen, valid id, exact premium, no active
  unexpired unpaid policy. Set policy (boughtAt now, expiry now + 1 day), push buyer.
  Emit PassBought(buyer, id, premium, expiry).
- setStation(id, status, cause) onlyOracle: CLEAR forces cause NONE; ALERT and
  DISRUPTED require cause != NONE; DISRUPTED sets disruptedAtBlock = block.number.
  Emit StationUpdated(id, status, cause, block.number).
- payout(addr) onlyAgent nonReentrant: eligible (active, !paid, expiry > now,
  now >= boughtAt + waitingPeriod, station DISRUPTED), balance >= payoutAmount.
  Effects first (paid, active = false, paidBlock), then transfer; require success.
  Emit PayoutSent(addr, stationId, amount).
- payoutBatch(addr[]) onlyAgent nonReentrant: same checks; skip ineligible; if a
  transfer fails, restore that policy and emit PayoutFailed; continue. Return count paid.
- Views: getAllStatuses() -> (Status[6], Cause[6]); buyerCount(id);
  getSnapshot(id, offset, limit) -> (address[], Policy[]); vaultCoverage() ->
  balance / payoutAmount.
- Owner: setAgent, setOracle, setPremium, setPayout, setSalesOpen, setWaitingPeriod,
  withdraw(amount). receive() funds the vault.
- No global counter written in payout paths.

## 9. Repo layout
```
FastLocal/
  CLAUDE.md
  .github/copilot-instructions.md
  docs/PRD.md
  contracts/                 Foundry: src, test, script
  web/                       Next.js App Router, TypeScript, Tailwind, viem
    app/page.tsx             phone flow
    app/screen/page.tsx      operator + big screen
    app/api/drip/route.ts
    app/api/admin/station/route.ts
    app/api/admin/payout/route.ts
    app/api/health/route.ts  balances of vault, relayer, agents
    components/              UI only
    lib/config.ts            chain, address, stations, amounts, display rate
    lib/abi.ts
    lib/types.ts
    lib/fastlocal.ts         client helpers
    lib/server/clients.ts    server wallet clients (server only)
    lib/server/payout-engine.ts
    scripts/agent.ts         autonomous worker
    scripts/seed.ts          load test
  README.md
```

## 10. Shared types (web/lib/types.ts)
```ts
export type StationStatus = "CLEAR" | "ALERT" | "DISRUPTED";
export type Cause =
  | "NONE" | "RAIN_FLOOD" | "SIGNAL_FAILURE" | "POWER_FAILURE" | "TRACK_FAULT" | "OTHER";
export type Station = { id: number; name: string; line: string; lat: number; lon: number };
export type PolicyView = {
  stationId: number; boughtAt: number; expiry: number; paidBlock: number;
  active: boolean; paid: boolean;
};
export type BuyerRow = { address: `0x${string}`; policy: PolicyView };
export type StationSnapshot = {
  stationId: number; status: StationStatus; cause: Cause;
  disruptedAtBlock: number; buyers: BuyerRow[];
};
export type Health = {
  vaultMon: string; vaultCoverage: number; relayerMon: string;
  agentWorkerMon: string; agentServerMon: string;
};
export type PhoneState =
  | "creating" | "funding" | "ready" | "buying" | "protected" | "paid" | "closed" | "error";
```
Client helpers (web/lib/fastlocal.ts): getOrCreateBurner(), ensureFunded(address),
getStatuses(), getPremium(id), getPolicy(address), buyPass(account, id),
getSnapshot(id), findPayoutTx(address).

## 11. Config
- Stations (approximate coordinates, check on a map):
  0 CSMT (18.940, 72.835), 1 Dadar (19.018, 72.843), 2 Kurla (19.065, 72.879),
  3 Sion (19.047, 72.863), 4 Andheri (19.119, 72.846), 5 Thane (19.186, 72.976).
  Default station: Dadar.
- Display rate: 0.0001 MON = Rs 1. Base premium 0.001 MON (Rs 10).
  Payout 0.03 MON (Rs 300). All values in one config file and owner-settable on chain.
- Drip: measured buyPass gas cost x 3 + premium.
- Env (server): RPC_URL, ORACLE_PRIVATE_KEY, RELAYER_PRIVATE_KEY,
  AGENT_SERVER_PRIVATE_KEY, AGENT_WORKER_ADDRESS, ADMIN_PASSCODE, DRIP_AMOUNT_MON.
- Env (worker, local): RPC_URL, AGENT_WORKER_PRIVATE_KEY, ORACLE_PRIVATE_KEY,
  ORACLE_MODE (manual | auto), ALERT_MM, CLEAR_MM, CONTRACT_ADDRESS.
- Env (client): NEXT_PUBLIC_CONTRACT_ADDRESS, NEXT_PUBLIC_RPC_URL,
  NEXT_PUBLIC_EXPLORER_URL, NEXT_PUBLIC_CHAIN_ID.

## 12. Reliability rules
- No getLogs in the critical path. findPayoutTx may scan the last ~100 blocks;
  fallback is the explorer address page.
- Private keys server-side only. Key-using routes: runtime nodejs.
- Explicit gas limit on every write (estimate x 1.2 to 1.3). Monad charges by gas limit.
- Phone polls every 3 s, every 1 s when its station is DISRUPTED. Back off on RPC errors.
- Admin routes check ADMIN_PASSCODE, with a simple attempt limit.
- UI and README state only measured numbers.

## 13. Edge cases (required behavior)
| Case | Behavior |
|---|---|
| Station DISRUPTED before user buys | Phone shows "Sales closed at {station}" |
| User buys during ALERT | Pays 2x; the price shown matches premiumFor at send time |
| Price changes between view and send | Tx reverts; phone refetches price and asks for one more tap |
| User taps buy twice / two tabs | Second tx reverts (active policy); phone shows protected state |
| Page reload during drip | Drip API rechecks balance and nonce; burner key persists |
| localStorage cleared | New burner; old policy stays on chain. UI labels it "demo wallet" |
| Disruption at another station | Policy not paid; phone stays protected |
| Policy expired | Not paid; user can buy again |
| Paid user wants a new pass | Allowed when station is not DISRUPTED |
| Vault too low | Engine reports failures; health panel shows coverage; operator funds vault; next cycle pays |
| Relayer empty | Drip API returns clear error; health panel warns |
| Agent gas low | Worker logs a warning each cycle |
| Worker down | Operator presses "Run payouts now" (fallback route) |
| Worker + fallback at same time | payoutBatch skips paid entries; no double pay |
| Tx stuck / timeout | Engine re-syncs nonce, retries with payoutBatch |
| Operator resets to CLEAR too early | Screen blocks Reset while eligible unpaid policies exist, unless forced |
| Recipient rejects payment | Batch restores that policy, emits PayoutFailed, continues |
| RPC rate limit | Client backoff; use a private RPC URL if available |
| Contract redeployed | Update Vercel env + redeploy, worker env, README |

## 14. Business
- Pre-market fit: venue survey + real passes bought on testnet today.
- Revenue: premium pool with a target loss ratio; B2B cover for employers and gig
  platforms; sponsored relief pools (brand-funded free passes); disruption data.
- Year-round: rain in the monsoon, signal, power, and track faults all year.
- Expansion: more Mumbai stations, then metro and suburban networks in other cities.
- Go-to-market: 3 high-disruption stations, 1 employer partner, a licensed insurance
  partner or a sponsored-relief model.

## 15. Limitations and next steps
- Single oracle operator in this version. Next: quorum of rail service status,
  rainfall data, and verified commuter reports.
- Payouts in testnet MON at a demo rate. Next: stablecoin payouts and UPI off-ramp.
- No coverage cap per station yet. Next: cap passes per station by vault size.
- Burner wallets are demo wallets.
