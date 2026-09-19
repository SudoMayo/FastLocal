// Autonomous payout agent. Run: npm run agent
// State-driven loop: every 2 s, find DISRUPTED stations with eligible unpaid policies and pay them.
// Restart-safe: the contract blocks double payouts.
import "./env";
import { createPublicClient, formatEther, http, parseEther, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CAUSE_LABELS, chain, CONTRACT_ADDRESS, RPC_URL as PUBLIC_RPC_URL, STATIONS } from "../lib/config";
import { readEligible, readStatuses } from "../lib/contract";
import { runPayouts, type EngineDeps } from "../lib/server/payout-engine";

const TICK_MS = 2_000;
const HEARTBEAT_MS = 30_000;
const LOW_GAS_MON = "0.5";

const key = process.env.AGENT_WORKER_PRIVATE_KEY;
if (!key) {
  console.error("[agent] AGENT_WORKER_PRIVATE_KEY is not set in web/.env.local");
  process.exit(1);
}
if (/^0x0{40}$/.test(CONTRACT_ADDRESS)) {
  console.error("[agent] CONTRACT_ADDRESS is not set in web/.env.local");
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL || PUBLIC_RPC_URL;
const publicClient: PublicClient = createPublicClient({
  chain,
  transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  batch: { multicall: true },
});
const account = privateKeyToAccount(key as `0x${string}`);
const deps: EngineDeps = { publicClient, account, chainId: chain.id };

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

// Per-station lock. Runs go through one queue because all payouts share the agent's nonce.
const inFlight = new Set<number>();
let queue: Promise<void> = Promise.resolve();

function schedule(stationId: number, causeLabel: string) {
  inFlight.add(stationId);
  queue = queue
    .then(async () => {
      const name = STATIONS[stationId].name;
      const t0 = Date.now();
      const r = await runPayouts(deps, stationId);
      if (r.eligible === 0) return;
      const blocks = r.firstBlock !== null ? `blocks ${r.firstBlock}..${r.lastBlock}` : "no blocks";
      const failed = r.failed > 0 ? `, failed ${r.failed} (retry next cycle)` : "";
      log(
        `[agent] ${name} DISRUPTED (${causeLabel}): ${r.eligible} eligible -> paid ${r.paid}, ${blocks}${failed} [${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.txHashes.length} txs]`,
      );
    })
    .catch((err) => log(`[agent] ${STATIONS[stationId].name} run failed: ${shortError(err)}`))
    .finally(() => inFlight.delete(stationId));
}

let lastHeartbeat = 0;

async function tick() {
  const [statuses, balance] = await Promise.all([
    readStatuses(publicClient),
    publicClient.getBalance({ address: account.address }),
  ]);

  if (balance < parseEther(LOW_GAS_MON)) {
    log(`[agent] WARNING low gas: ${formatEther(balance)} MON (< ${LOW_GAS_MON}). Fund ${account.address}`);
  }

  const disrupted = statuses.flatMap((s, id) => (s.status === "DISRUPTED" ? [id] : []));
  for (const id of disrupted) {
    if (inFlight.has(id)) continue;
    const { eligible } = await readEligible(publicClient, id);
    if (eligible.length > 0) schedule(id, CAUSE_LABELS[statuses[id].cause]);
  }

  if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = Date.now();
    const summary = disrupted.length ? disrupted.map((id) => STATIONS[id].name).join(", ") + " DISRUPTED" : "all stations running";
    log(`[agent] alive: ${summary}; gas ${Number(formatEther(balance)).toFixed(3)} MON`);
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n").slice(0, 2).join(" ");
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    log(`[agent] cycle error (continuing): ${shortError(err)}`);
  }
  setTimeout(loop, TICK_MS);
}

process.on("unhandledRejection", (err) => log(`[agent] unhandled (continuing): ${shortError(err)}`));

log(`[agent] starting. agent ${account.address}, contract ${CONTRACT_ADDRESS}, rpc ${new URL(rpcUrl).host}`);
loop();
