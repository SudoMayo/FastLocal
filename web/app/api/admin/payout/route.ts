// Fallback payout: operator presses "Run payouts now" when the worker is down.
// Uses the AGENT_SERVER key and payoutBatch only, so racing the worker is safe.
import { nonceManager } from "viem";
import { STATION_COUNT } from "@/lib/config";
import { agentServerSigner, publicClient } from "@/lib/server/clients";
import { checkAdmin, errorMessage } from "@/lib/server/guard";
import { runBatchPayouts } from "@/lib/server/payout-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const auth = checkAdmin(req, body?.passcode);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const stationId = Number(body?.stationId);
  if (!Number.isInteger(stationId) || stationId < 0 || stationId >= STATION_COUNT) {
    return Response.json({ error: "Invalid stationId" }, { status: 400 });
  }

  const { account, wallet } = agentServerSigner();
  try {
    const result = await runBatchPayouts({ publicClient, account, chainId: wallet.chain!.id }, stationId);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    nonceManager.reset({ address: account.address, chainId: wallet.chain!.id });
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
