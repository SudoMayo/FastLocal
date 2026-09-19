// Balances of the vault, relayer and both agents. No secrets in the response.
import { connection } from "next/server";
import { formatEther } from "viem";
import { fastLocal } from "@/lib/contract";
import { agentServerSigner, agentWorkerAddress, publicClient, relayerSigner } from "@/lib/server/clients";
import { errorMessage } from "@/lib/server/guard";
import type { Health } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  await connection(); // always live, never prerendered
  try {
    const [vault, coverage, relayer, worker, server] = await Promise.all([
      publicClient.getBalance({ address: fastLocal.address }),
      publicClient.readContract({ ...fastLocal, functionName: "vaultCoverage" }),
      publicClient.getBalance({ address: relayerSigner().account.address }),
      publicClient.getBalance({ address: agentWorkerAddress() }),
      publicClient.getBalance({ address: agentServerSigner().account.address }),
    ]);
    const health: Health = {
      vaultMon: formatEther(vault),
      vaultCoverage: Number(coverage),
      relayerMon: formatEther(relayer),
      agentWorkerMon: formatEther(worker),
      agentServerMon: formatEther(server),
    };
    return Response.json(health, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
