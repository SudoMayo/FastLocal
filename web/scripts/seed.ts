// Load test: N fresh wallets, funded by the relayer, each buys a pass at one station.
// Run: npm run seed -- --count 20 --station 1
import "./env";
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
  type Hash,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chain, RPC_URL as PUBLIC_RPC_URL, STATIONS } from "../lib/config";
import { bufferGas, fastLocal } from "../lib/contract";

const RESERVE_WEI = parseEther("10"); // Monad reserve balance for the relayer
const GROUP = 10;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} must be a whole number`);
  return v;
}

async function main() {
  const count = arg("count", 20);
  const stationId = arg("station", 1);
  if (stationId >= STATIONS.length) throw new Error(`--station must be 0..${STATIONS.length - 1}`);
  const fundWei = parseEther(process.env.SEED_FUND_MON || "0.035");

  const relayerKey = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!relayerKey) throw new Error("RELAYER_PRIVATE_KEY is not set in web/.env.local");
  const client: PublicClient = createPublicClient({
    chain,
    transport: http(process.env.RPC_URL || PUBLIC_RPC_URL, { retryCount: 2 }),
  });
  const relayer = privateKeyToAccount(relayerKey);

  // Relayer must stay above the 10 MON reserve.
  const relayerBal = await client.getBalance({ address: relayer.address });
  const need = fundWei * BigInt(count) + parseEther("0.1");
  if (relayerBal - need < RESERVE_WEI) {
    throw new Error(`Relayer has ${formatEther(relayerBal)} MON; needs ${formatEther(need)} above the 10 MON reserve`);
  }

  // 1. Throwaway wallets. Only their addresses are logged (to .secrets/, gitignored).
  const wallets = Array.from({ length: count }, () => privateKeyToAccount(generatePrivateKey()));
  const secretsDir = path.join(__dirname, "..", "..", ".secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  console.log(`[seed] ${count} wallets -> ${STATIONS[stationId].name}, ${formatEther(fundWei)} MON each`);

  // 2. Fund from relayer: explicit nonces, groups of 10.
  const fees = await client.estimateFeesPerGas();
  let nonce = await client.getTransactionCount({ address: relayer.address, blockTag: "pending" });
  const fundHashes: Hash[] = [];
  for (let i = 0; i < count; i += GROUP) {
    const group = wallets.slice(i, i + GROUP);
    const hashes = await Promise.all(
      group.map(async (w, j) =>
        client.sendRawTransaction({
          serializedTransaction: await relayer.signTransaction({
            chainId: chain.id,
            type: "eip1559",
            to: w.address,
            value: fundWei,
            gas: 21_000n,
            nonce: nonce + j,
            ...fees,
          }),
        }),
      ),
    );
    nonce += group.length;
    fundHashes.push(...hashes);
  }
  await Promise.all(fundHashes.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 60_000 })));
  console.log(`[seed] funded ${fundHashes.length} wallets`);

  // 3. Each wallet buys a pass (different senders, so they can go in parallel).
  const premium = await client.readContract({ ...fastLocal, functionName: "premiumFor", args: [stationId] });
  const data = encodeFunctionData({ abi: fastLocal.abi, functionName: "buyPass", args: [stationId] });
  let bought = 0;
  const failures: string[] = [];
  for (let i = 0; i < count; i += GROUP) {
    const group = wallets.slice(i, i + GROUP);
    const results = await Promise.allSettled(
      group.map(async (w) => {
        const gas = await client.estimateContractGas({
          ...fastLocal,
          functionName: "buyPass",
          args: [stationId],
          value: premium,
          account: w,
        });
        const hash = await client.sendRawTransaction({
          serializedTransaction: await w.signTransaction({
            chainId: chain.id,
            type: "eip1559",
            to: fastLocal.address,
            data,
            value: premium,
            gas: bufferGas(gas),
            nonce: 0,
            ...fees,
          }),
        });
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== "success") throw new Error(`reverted ${hash}`);
      }),
    );
    results.forEach((r, j) => {
      if (r.status === "fulfilled") bought++;
      else failures.push(`${group[j].address}: ${(r.reason as Error).message.split("\n")[0]}`);
    });
  }

  fs.appendFileSync(
    path.join(secretsDir, "seed-wallets.txt"),
    wallets.map((w) => `${new Date().toISOString()} station=${stationId} ${w.address}`).join("\n") + "\n",
  );
  console.log(`[seed] bought ${bought}/${count} passes at ${STATIONS[stationId].name}`);
  failures.forEach((f) => console.log(`[seed] failed ${f}`));
}

main().catch((err) => {
  console.error(`[seed] error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
