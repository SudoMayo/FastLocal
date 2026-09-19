// Single source for chain, contract, stations, amounts and display rate.
// Browser-safe: only NEXT_PUBLIC_* values (and CONTRACT_ADDRESS for the local worker).
import { defineChain, parseEther } from "viem";
import { monadTestnet } from "viem/chains";
import type { Cause, Station, StationStatus } from "./types";

// Chain values confirmed on https://docs.monad.xyz/developer-essentials/testnets
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || monadTestnet.id);
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
export const EXPLORER_URL = (
  process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.monadvision.com"
).replace(/\/$/, "");

export const chain = defineChain({
  ...monadTestnet,
  id: CHAIN_ID,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "MonadVision", url: EXPLORER_URL } },
});

export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ||
  process.env.CONTRACT_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

// Approximate coordinates; used by the rain oracle (P1).
export const STATIONS: Station[] = [
  { id: 0, name: "CSMT", line: "Central", lat: 18.94, lon: 72.835 },
  { id: 1, name: "Dadar", line: "Central / Western", lat: 19.018, lon: 72.843 },
  { id: 2, name: "Kurla", line: "Central / Harbour", lat: 19.065, lon: 72.879 },
  { id: 3, name: "Sion", line: "Central", lat: 19.047, lon: 72.863 },
  { id: 4, name: "Andheri", line: "Western", lat: 19.119, lon: 72.846 },
  { id: 5, name: "Thane", line: "Central", lat: 19.186, lon: 72.976 },
];
export const STATION_COUNT = STATIONS.length;
export const DEFAULT_STATION_ID = 1; // Dadar

// Order must match the Solidity enums.
export const STATUSES: StationStatus[] = ["CLEAR", "ALERT", "DISRUPTED"];
export const CAUSES: Cause[] = [
  "NONE", "RAIN_FLOOD", "SIGNAL_FAILURE", "POWER_FAILURE", "TRACK_FAULT", "OTHER",
];
export const CAUSE_LABELS: Record<Cause, string> = {
  NONE: "None",
  RAIN_FLOOD: "Rain flooding",
  SIGNAL_FAILURE: "Signal failure",
  POWER_FAILURE: "Power failure",
  TRACK_FAULT: "Track fault",
  OTHER: "Other",
};

// Amounts. The contract holds the live values (owner-settable); these are the defaults.
export const BASE_PREMIUM_MON = "0.001"; // Rs 10
export const PAYOUT_MON = "0.03"; // Rs 300
export const BASE_PREMIUM_WEI = parseEther(BASE_PREMIUM_MON);
export const PAYOUT_WEI = parseEther(PAYOUT_MON);

// Display rate: 0.0001 MON = Rs 1 (demo rate).
export const RUPEES_PER_MON = 10_000;
export function monToRupees(mon: number): number {
  return Math.round(mon * RUPEES_PER_MON);
}

// Polling (ms).
export const PHONE_POLL_MS = 3_000;
export const PHONE_POLL_DISRUPTED_MS = 1_000;
export const SCREEN_SNAPSHOT_POLL_MS = 2_000;
export const SCREEN_HEALTH_POLL_MS = 10_000;

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
