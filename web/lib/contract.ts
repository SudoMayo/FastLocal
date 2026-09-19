// Contract read helpers shared by the browser, API routes and the worker.
// No keys here. Safe to import anywhere.
import type { PublicClient } from "viem";
import { fastLocalAbi } from "./abi";
import { CAUSES, CONTRACT_ADDRESS, STATUSES } from "./config";
import type { BuyerRow, Cause, PolicyView, StationSnapshot, StationStatus } from "./types";

export const fastLocal = { address: CONTRACT_ADDRESS, abi: fastLocalAbi } as const;

export const SNAPSHOT_PAGE = 200n;

export function toStatus(n: number): StationStatus {
  return STATUSES[n] ?? "CLEAR";
}

export function toCause(n: number): Cause {
  return CAUSES[n] ?? "OTHER";
}

/** Gas limit = estimate x 1.3. Monad charges the full limit, so keep it tight. */
export function bufferGas(estimate: bigint): bigint {
  return (estimate * 13n) / 10n;
}

type RawPolicy = {
  stationId: number;
  boughtAt: bigint;
  expiry: bigint;
  paidBlock: bigint;
  active: boolean;
  paid: boolean;
};

export function toPolicyView(p: RawPolicy): PolicyView {
  return {
    stationId: Number(p.stationId),
    boughtAt: Number(p.boughtAt),
    expiry: Number(p.expiry),
    paidBlock: Number(p.paidBlock),
    active: p.active,
    paid: p.paid,
  };
}

/** Same rule as FastLocalCore.isEligible, evaluated off chain. */
export function isPolicyEligible(
  policy: PolicyView,
  stationStatus: StationStatus,
  nowSec: number,
  waitingPeriodSec: number,
): boolean {
  return (
    policy.active &&
    !policy.paid &&
    policy.expiry > nowSec &&
    nowSec >= policy.boughtAt + waitingPeriodSec &&
    stationStatus === "DISRUPTED"
  );
}

export async function readStatuses(client: PublicClient) {
  const [statuses, causes] = await client.readContract({
    ...fastLocal,
    functionName: "getAllStatuses",
  });
  return statuses.map((s, i) => ({ status: toStatus(s), cause: toCause(causes[i]) }));
}

/** Reads every buyer of a station in pages of 200. Rows whose policy moved to another station are dropped. */
export async function readSnapshot(client: PublicClient, stationId: number): Promise<StationSnapshot> {
  const id = stationId;
  const [count, status, cause, disruptedAtBlock] = await Promise.all([
    client.readContract({ ...fastLocal, functionName: "buyerCount", args: [id] }),
    client.readContract({ ...fastLocal, functionName: "stationStatus", args: [id] }),
    client.readContract({ ...fastLocal, functionName: "stationCause", args: [id] }),
    client.readContract({ ...fastLocal, functionName: "disruptedAtBlock", args: [id] }),
  ]);

  const pages: Promise<readonly [readonly `0x${string}`[], readonly RawPolicy[]]>[] = [];
  for (let offset = 0n; offset < count; offset += SNAPSHOT_PAGE) {
    pages.push(
      client.readContract({
        ...fastLocal,
        functionName: "getSnapshot",
        args: [id, offset, SNAPSHOT_PAGE],
      }),
    );
  }

  const buyers: BuyerRow[] = [];
  for (const [addrs, pols] of await Promise.all(pages)) {
    addrs.forEach((address, i) => {
      const policy = toPolicyView(pols[i]);
      if (policy.stationId === id) buyers.push({ address, policy });
    });
  }

  return {
    stationId: id,
    status: toStatus(status),
    cause: toCause(cause),
    disruptedAtBlock: Number(disruptedAtBlock),
    buyers,
  };
}

/** Eligible, unpaid addresses at a station, using chain time. */
export async function readEligible(client: PublicClient, stationId: number) {
  const [snapshot, block, waitingPeriod] = await Promise.all([
    readSnapshot(client, stationId),
    client.getBlock({ blockTag: "latest" }),
    client.readContract({ ...fastLocal, functionName: "waitingPeriod" }),
  ]);
  const nowSec = Number(block.timestamp);
  const eligible = snapshot.buyers
    .filter((b) => isPolicyEligible(b.policy, snapshot.status, nowSec, Number(waitingPeriod)))
    .map((b) => b.address);
  return { snapshot, eligible: [...new Set(eligible)] };
}
