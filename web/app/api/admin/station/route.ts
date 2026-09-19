// Operator sets a station status + cause with the oracle key.
import { nonceManager } from "viem";
import { CAUSES, STATION_COUNT, STATUSES } from "@/lib/config";
import { bufferGas, fastLocal, readEligible } from "@/lib/contract";
import { oracleSigner, publicClient } from "@/lib/server/clients";
import { checkAdmin, errorMessage } from "@/lib/server/guard";
import type { Cause, StationStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const auth = checkAdmin(req, body?.passcode);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const stationId = Number(body?.stationId);
  const status = body?.status as StationStatus;
  const cause = (status === "CLEAR" ? "NONE" : body?.cause) as Cause;
  if (!Number.isInteger(stationId) || stationId < 0 || stationId >= STATION_COUNT) {
    return Response.json({ error: "Invalid stationId" }, { status: 400 });
  }
  if (!STATUSES.includes(status)) return Response.json({ error: "Invalid status" }, { status: 400 });
  if (!CAUSES.includes(cause) || (status !== "CLEAR" && cause === "NONE")) {
    return Response.json({ error: "ALERT and DISRUPTED need a cause" }, { status: 400 });
  }

  const { account, wallet } = oracleSigner();
  try {
    // Block an early reset while people are still owed a payout.
    if (status !== "DISRUPTED" && body?.force !== true) {
      const { snapshot, eligible } = await readEligible(publicClient, stationId);
      if (snapshot.status === "DISRUPTED" && eligible.length > 0) {
        return Response.json(
          { error: `${eligible.length} eligible policies are still unpaid. Pay them first or force.`, eligible: eligible.length },
          { status: 409 },
        );
      }
    }

    const args = [stationId, STATUSES.indexOf(status), CAUSES.indexOf(cause)] as const;
    const gas = await publicClient.estimateContractGas({ ...fastLocal, functionName: "setStation", args, account });
    const txHash = await wallet.writeContract({
      ...fastLocal,
      functionName: "setStation",
      args,
      account,
      chain: wallet.chain,
      gas: bufferGas(gas),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 25_000 });
    if (receipt.status !== "success") {
      return Response.json({ error: "setStation reverted", txHash }, { status: 500 });
    }
    return Response.json({ ok: true, txHash, blockNumber: Number(receipt.blockNumber) });
  } catch (err) {
    nonceManager.reset({ address: account.address, chainId: wallet.chain!.id });
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
