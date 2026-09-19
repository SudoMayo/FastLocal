// Payout engine. Used by the worker (scripts/agent.ts) and the fallback route.
// No "server-only" import so tsx can load it; callers pass in their own clients and key.
import {
  decodeEventLog,
  encodeFunctionData,
  type Hash,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { bufferGas, fastLocal, readEligible } from "../contract";

export type EngineDeps = {
  publicClient: PublicClient;
  account: LocalAccount;
  chainId: number;
};

export type EngineResult = {
  eligible: number;
  paid: number;
  failed: number;
  txHashes: Hash[];
  firstBlock: number | null;
  lastBlock: number | null;
};

const GROUP_SIZE = 10;
const BATCH_CHUNK = 25;
const RECEIPT_TIMEOUT_MS = 30_000;

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** Signs locally with an explicit nonce and sends. One RPC call per tx. */
async function sendSigned(
  deps: EngineDeps,
  data: `0x${string}`,
  nonce: number,
  gas: bigint,
  fees: Fees,
): Promise<Hash> {
  const signed = await deps.account.signTransaction({
    chainId: deps.chainId,
    type: "eip1559",
    to: fastLocal.address,
    data,
    nonce,
    gas,
    ...fees,
  });
  return deps.publicClient.sendRawTransaction({ serializedTransaction: signed });
}

type Waited = { hash: Hash; receipt: TransactionReceipt | null };

async function waitAll(deps: EngineDeps, hashes: Hash[]): Promise<{ results: Waited[]; timedOut: boolean }> {
  let timedOut = false;
  const results = await Promise.all(
    hashes.map(async (hash) => {
      try {
        const receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        return { hash, receipt };
      } catch {
        timedOut = true;
        return { hash, receipt: null };
      }
    }),
  );
  return { results, timedOut };
}

/** Addresses paid in a receipt, from its PayoutSent logs. */
function paidInReceipt(receipt: TransactionReceipt): `0x${string}`[] {
  const paid: `0x${string}`[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== fastLocal.address.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: fastLocal.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "PayoutSent") paid.push(ev.args.buyer);
    } catch {}
  }
  return paid;
}

class Tally {
  paid = new Set<string>();
  txHashes: Hash[] = [];
  firstBlock: number | null = null;
  lastBlock: number | null = null;

  add(receipt: TransactionReceipt) {
    const paid = paidInReceipt(receipt);
    if (paid.length === 0) return;
    paid.forEach((a) => this.paid.add(a.toLowerCase()));
    const block = Number(receipt.blockNumber);
    this.firstBlock = this.firstBlock === null ? block : Math.min(this.firstBlock, block);
    this.lastBlock = this.lastBlock === null ? block : Math.max(this.lastBlock, block);
  }

  result(eligible: number): EngineResult {
    return {
      eligible,
      paid: this.paid.size,
      failed: Math.max(0, eligible - this.paid.size),
      txHashes: this.txHashes,
      firstBlock: this.firstBlock,
      lastBlock: this.lastBlock,
    };
  }
}

/** Bumps fees 20% so a resend can replace a stuck tx with the same nonce. */
function bump(fees: Fees): Fees {
  return {
    maxFeePerGas: (fees.maxFeePerGas * 12n) / 10n,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 12n) / 10n,
  };
}

/**
 * payoutBatch in chunks of 25 with explicit nonces. Already-paid entries are
 * skipped on chain, so racing another agent is safe.
 */
async function batchPay(
  deps: EngineDeps,
  addrs: `0x${string}`[],
  tally: Tally,
  opts: { nonce?: number; fees?: Fees } = {},
): Promise<{ timedOut: boolean }> {
  if (addrs.length === 0) return { timedOut: false };
  let nonce = opts.nonce ?? (await deps.publicClient.getTransactionCount({ address: deps.account.address, blockTag: "pending" }));
  const fees = opts.fees ?? (await deps.publicClient.estimateFeesPerGas());

  const hashes: Hash[] = [];
  for (let i = 0; i < addrs.length; i += BATCH_CHUNK) {
    const chunk = addrs.slice(i, i + BATCH_CHUNK);
    const args = [chunk] as const;
    const est = await deps.publicClient.estimateContractGas({
      ...fastLocal,
      functionName: "payoutBatch",
      args,
      account: deps.account,
    });
    const data = encodeFunctionData({ abi: fastLocal.abi, functionName: "payoutBatch", args });
    hashes.push(await sendSigned(deps, data, nonce++, bufferGas(est), fees));
  }
  tally.txHashes.push(...hashes);
  const { results, timedOut } = await waitAll(deps, hashes);
  results.forEach((r) => r.receipt && tally.add(r.receipt));
  return { timedOut };
}

/** Worker path: burst of payout(addr), then one payoutBatch retry for anything unpaid. */
export async function runPayouts(deps: EngineDeps, stationId: number): Promise<EngineResult> {
  // 1. Eligible addresses (snapshot pages of 200), deduped.
  const { eligible } = await readEligible(deps.publicClient, stationId);
  const tally = new Tally();
  if (eligible.length === 0) return tally.result(0);

  // 2. Burst: nonce, gas and fees read once.
  let gasEstimate: bigint;
  try {
    gasEstimate = await deps.publicClient.estimateContractGas({
      ...fastLocal,
      functionName: "payout",
      args: [eligible[0]],
      account: deps.account,
    });
  } catch (err) {
    // Another agent (the fallback route) may have just paid them. That is fine.
    const again = await readEligible(deps.publicClient, stationId);
    if (again.eligible.length === 0) return tally.result(0);
    throw err;
  }
  const [startNonce, fees] = await Promise.all([
    deps.publicClient.getTransactionCount({ address: deps.account.address, blockTag: "pending" }),
    deps.publicClient.estimateFeesPerGas(),
  ]);
  const gas = bufferGas(gasEstimate);

  const sent: Hash[] = [];
  let nonce = startNonce;
  for (let i = 0; i < eligible.length; i += GROUP_SIZE) {
    const group = eligible.slice(i, i + GROUP_SIZE);
    const settled = await Promise.allSettled(
      group.map((addr, j) =>
        sendSigned(deps, encodeFunctionData({ abi: fastLocal.abi, functionName: "payout", args: [addr] }), nonce + j, gas, fees),
      ),
    );
    nonce += group.length;
    settled.forEach((s) => s.status === "fulfilled" && sent.push(s.value));
  }
  tally.txHashes.push(...sent);

  // 3. Receipts.
  const { results, timedOut } = await waitAll(deps, sent);
  results.forEach((r) => r.receipt && tally.add(r.receipt));

  // 4. Retry anything unpaid once with payoutBatch.
  const unpaid = eligible.filter((a) => !tally.paid.has(a.toLowerCase()));
  if (unpaid.length > 0) {
    try {
      // After a timeout or a send error, re-sync the nonce from chain and bump fees to replace stuck txs.
      const needResync = timedOut || sent.length < eligible.length;
      const retryNonce = needResync
        ? await deps.publicClient.getTransactionCount({ address: deps.account.address, blockTag: "latest" })
        : undefined;
      await batchPay(deps, unpaid, tally, needResync ? { nonce: retryNonce, fees: bump(fees) } : {});
    } catch {
      // Keep the partial result. The next cycle picks up whatever is still unpaid.
    }
  }

  // 5. Summary.
  return tally.result(eligible.length);
}

/** Fallback path (API route): payoutBatch only. */
export async function runBatchPayouts(deps: EngineDeps, stationId: number): Promise<EngineResult> {
  const { eligible } = await readEligible(deps.publicClient, stationId);
  const tally = new Tally();
  if (eligible.length > 0) await batchPay(deps, eligible, tally);
  return tally.result(eligible.length);
}
