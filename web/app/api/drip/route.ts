// Gas drip for new burner wallets. Funds only fresh wallets (balance 0 and nonce 0).
import { formatEther, isAddress, nonceManager, parseEther } from "viem";
import { publicClient, relayerSigner, dripAmountMon } from "@/lib/server/clients";
import { clientIp, errorMessage, hit } from "@/lib/server/guard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Monad reserve balance: an EOA cannot send value that takes it below 10 MON.
const RELAYER_RESERVE_WEI = parseEther("10");
const TRANSFER_GAS = 21_000n;

type DripResult =
  | { ok: true; status: "funded" | "pending" | "already_funded"; txHash?: `0x${string}` }
  | { ok: false; error: string; code: number };

// One drip per address at a time, even if the phone reloads mid-drip.
const inFlight = new Map<string, Promise<DripResult>>();

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const address = typeof body?.address === "string" ? body.address : "";
  if (!isAddress(address)) return json({ ok: false, error: "Invalid address", code: 400 });

  // Venue wifi shares one IP, so the IP limit is generous.
  if (!hit(`drip-ip:${clientIp(req)}`, 60, 10 * 60_000)) {
    return json({ ok: false, error: "Too many requests from this network. Wait a minute.", code: 429 });
  }
  if (!hit(`drip-addr:${address.toLowerCase()}`, 5, 10 * 60_000)) {
    return json({ ok: false, error: "Too many drip requests for this wallet.", code: 429 });
  }

  const key = address.toLowerCase();
  let job = inFlight.get(key);
  if (!job) {
    job = drip(address as `0x${string}`).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return json(await job);
}

async function drip(to: `0x${string}`): Promise<DripResult> {
  try {
    const [balance, nonce] = await Promise.all([
      publicClient.getBalance({ address: to }),
      publicClient.getTransactionCount({ address: to }),
    ]);
    if (balance > 0n) return { ok: true, status: "already_funded" };
    if (nonce > 0) {
      return { ok: false, error: "This wallet was already used. Drips are for new demo wallets only.", code: 409 };
    }

    const { account, wallet } = relayerSigner();
    const amount = parseEther(dripAmountMon());
    const [relayerBalance, fees] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.estimateFeesPerGas(),
    ]);
    const maxGasCost = TRANSFER_GAS * fees.maxFeePerGas;
    if (relayerBalance - amount - maxGasCost < RELAYER_RESERVE_WEI) {
      return {
        ok: false,
        error: `Gas drip is empty (relayer has ${formatEther(relayerBalance)} MON, needs over 10 MON reserve). Tell the operator.`,
        code: 503,
      };
    }

    const txHash = await wallet.sendTransaction({
      account,
      chain: wallet.chain,
      to,
      value: amount,
      gas: TRANSFER_GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 20_000 });
      if (receipt.status !== "success") return { ok: false, error: "Drip transaction reverted", code: 500 };
      return { ok: true, status: "funded", txHash };
    } catch {
      // Sent but slow. The phone keeps polling its balance.
      return { ok: true, status: "pending", txHash };
    }
  } catch (err) {
    // Next send re-reads the nonce from chain.
    try {
      const { account, wallet } = relayerSigner();
      nonceManager.reset({ address: account.address, chainId: wallet.chain!.id });
    } catch {}
    console.error("[drip] failed:", errorMessage(err));
    return { ok: false, error: `Drip failed: ${errorMessage(err)}`, code: 500 };
  }
}

function json(result: DripResult) {
  return Response.json(result, { status: result.ok ? 200 : result.code });
}
