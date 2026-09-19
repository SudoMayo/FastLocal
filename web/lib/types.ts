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
