// Browser helpers: burner wallet, drip, reads, buyPass, payout lookup.
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chain, CONTRACT_ADDRESS, RPC_URL, RUPEES_PER_MON, STATIONS } from "./config";
import { bufferGas, fastLocal, readSnapshot, readStatuses, toPolicyView } from "./contract";
import type { PolicyView } from "./types";

const transport = http(RPC_URL, { retryCount: 2 });

// Reads fired in the same tick are merged into one multicall (one RPC request).
export const client: PublicClient = createPublicClient({ chain, transport, batch: { multicall: true } });

const BURNER_KEY = "fastlocal:burner";
let memoryKey: `0x${string}` | null = null; // fallback when localStorage is blocked

/** Loads the demo wallet from localStorage, or creates one. */
export function getOrCreateBurner(): { account: PrivateKeyAccount; isNew: boolean } {
  let key: `0x${string}` | null = null;
  try {
    key = localStorage.getItem(BURNER_KEY) as `0x${string}` | null;
  } catch {}
  key = key ?? memoryKey;
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    return { account: privateKeyToAccount(key), isNew: false };
  }
  const fresh = generatePrivateKey();
  memoryKey = fresh;
  try {
    localStorage.setItem(BURNER_KEY, fresh);
  } catch {}
  return { account: privateKeyToAccount(fresh), isNew: true };
}

/** Forgets the demo wallet so the next load creates a new one. Old passes stay on chain. */
export function resetBurner() {
  memoryKey = null;
  try {
    localStorage.removeItem(BURNER_KEY);
  } catch {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries a read with backoff (1 s, 2 s, 4 s) so a busy public RPC does not fail setup. */
async function withBackoff<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await sleep(1_000 * 2 ** i);
    }
  }
}

/** Short, human error text. Raw RPC errors are long and unreadable on a phone. */
export function friendlyError(err: unknown): string {
  const text = errorText(err);
  const lower = text.toLowerCase();
  if (lower.includes("limit") || lower.includes("429") || lower.includes("too many")) {
    return "The network is busy right now. Tap Try again in a few seconds.";
  }
  if (lower.includes("fetch failed") || lower.includes("failed to fetch") || lower.includes("http request failed")) {
    return "Could not reach the network. Check your connection and tap Try again.";
  }
  const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** Makes sure the burner has gas. Asks /api/drip once, then waits for the balance. */
export async function ensureFunded(address: `0x${string}`): Promise<bigint> {
  const balance = await withBackoff(() => client.getBalance({ address }));
  if (balance > 0n) return balance;

  const res = await fetch("/api/drip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Drip failed (HTTP ${res.status})` }));
  if (!data.ok) throw new Error(data.error || "Drip failed");

  for (let i = 0; i < 30; i++) {
    const b = await client.getBalance({ address }).catch(() => 0n); // keep waiting through RPC hiccups
    if (b > 0n) return b;
    await sleep(1_000);
  }
  throw new Error("Gas drip is taking longer than usual. Tap retry.");
}

export function getStatuses() {
  return readStatuses(client);
}

/** Current price for a station, or null when sales are closed (DISRUPTED). */
export async function getPremium(stationId: number): Promise<bigint | null> {
  try {
    return await client.readContract({ ...fastLocal, functionName: "premiumFor", args: [stationId] });
  } catch (err) {
    if (revertReason(err) === "Sales closed") return null;
    throw err;
  }
}

export async function getPayoutAmount(): Promise<bigint> {
  return client.readContract({ ...fastLocal, functionName: "payoutAmount" });
}

/** The wallet's policy, or null if it never bought. */
export async function getPolicy(address: `0x${string}`): Promise<PolicyView | null> {
  const [stationId, boughtAt, expiry, paidBlock, active, paid] = await client.readContract({
    ...fastLocal,
    functionName: "policies",
    args: [address],
  });
  if (boughtAt === 0n) return null;
  return toPolicyView({ stationId, boughtAt, expiry, paidBlock, active, paid });
}

export type BuyErrorKind =
  | "PRICE_CHANGED" | "ALREADY_PROTECTED" | "SALES_CLOSED" | "SALES_PAUSED" | "LOW_BALANCE" | "UNKNOWN";

export class BuyError extends Error {
  constructor(public kind: BuyErrorKind, message: string) {
    super(message);
  }
}

/** Buys a pass. Reads premiumFor right before sending so the price matches. */
export async function buyPass(account: PrivateKeyAccount, stationId: number) {
  try {
    const premium = await client.readContract({ ...fastLocal, functionName: "premiumFor", args: [stationId] });
    const gas = await client.estimateContractGas({
      ...fastLocal,
      functionName: "buyPass",
      args: [stationId],
      value: premium,
      account,
    });
    const wallet = createWalletClient({ account, chain, transport });
    const hash = await wallet.writeContract({
      ...fastLocal,
      functionName: "buyPass",
      args: [stationId],
      value: premium,
      gas: bufferGas(gas),
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") {
      // Price or status changed between our read and inclusion.
      throw new BuyError("PRICE_CHANGED", "The price changed. Tap once more to confirm the new price.");
    }
    return { hash, premium };
  } catch (err) {
    throw toBuyError(err);
  }
}

function toBuyError(err: unknown): BuyError {
  if (err instanceof BuyError) return err;
  const reason = revertReason(err);
  const text = errorText(err).toLowerCase();
  if (reason === "Wrong premium") return new BuyError("PRICE_CHANGED", "The price changed. Tap once more to confirm the new price.");
  if (reason === "Active policy") return new BuyError("ALREADY_PROTECTED", "You already have an active pass.");
  if (reason === "Sales closed") return new BuyError("SALES_CLOSED", "Sales just closed at this station.");
  if (reason === "Sales paused") return new BuyError("SALES_PAUSED", "Pass sales are paused right now.");
  if (text.includes("insufficient")) return new BuyError("LOW_BALANCE", "Your demo wallet is out of gas money.");
  return new BuyError("UNKNOWN", friendlyError(err));
}

function revertReason(err: unknown): string | null {
  const text = errorText(err);
  for (const r of ["Wrong premium", "Active policy", "Sales closed", "Sales paused"]) {
    if (text.includes(r)) return r;
  }
  return null;
}

function errorText(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details ?? ""} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function getSnapshot(stationId: number) {
  return readSnapshot(client, stationId);
}

/** Operator screen: every station's snapshot plus chain time, in one multicall. */
export async function getAllSnapshots() {
  const [snapshots, block, waitingPeriod] = await Promise.all([
    Promise.all(STATIONS.map((s) => readSnapshot(client, s.id))),
    client.getBlock({ blockTag: "latest" }),
    client.readContract({ ...fastLocal, functionName: "waitingPeriod" }),
  ]);
  return { snapshots, nowSec: Number(block.timestamp), waitingPeriod: Number(waitingPeriod) };
}

const blockTimes = new Map<number, number>();

/** Block timestamp in seconds (Monad block timestamps have 1 s resolution). Cached. */
export async function getBlockTime(blockNumber: number): Promise<number> {
  const cached = blockTimes.get(blockNumber);
  if (cached !== undefined) return cached;
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  blockTimes.set(blockNumber, Number(block.timestamp));
  return Number(block.timestamp);
}

/**
 * Finds the payout tx using the policy's paidBlock: one block read, no getLogs.
 * Returns null if not found; the UI then links the explorer address page.
 */
export async function findPayoutTx(address: `0x${string}`, paidBlock?: number): Promise<`0x${string}` | null> {
  try {
    const blockNumber = paidBlock ?? (await getPolicy(address))?.paidBlock;
    if (!blockNumber) return null;
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber), includeTransactions: true });
    const needle = address.toLowerCase().slice(2);
    const tx = block.transactions.find(
      (t) => t.to?.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() && t.input.toLowerCase().includes(needle),
    );
    return tx?.hash ?? null;
  } catch {
    return null;
  }
}

export function weiToRupees(wei: bigint): number {
  return Math.round(Number(formatEther(wei)) * RUPEES_PER_MON);
}
