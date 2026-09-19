// Server wallet clients. Private keys never leave the server.
import "server-only";
import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chain, RPC_URL as PUBLIC_RPC_URL } from "../config";

const RPC_URL = process.env.RPC_URL || PUBLIC_RPC_URL;
const transport = http(RPC_URL, { retryCount: 2, timeout: 15_000 });

export const publicClient: PublicClient = createPublicClient({
  chain,
  transport,
  batch: { multicall: true },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Server env ${name} is not set`);
  return value;
}

type Signer = { account: PrivateKeyAccount; wallet: WalletClient };
const signers = new Map<string, Signer>();

/** One cached signer per key env var. nonceManager keeps concurrent sends in order. */
function signer(envName: string): Signer {
  let s = signers.get(envName);
  if (!s) {
    const account = privateKeyToAccount(requireEnv(envName) as `0x${string}`, { nonceManager });
    s = { account, wallet: createWalletClient({ account, chain, transport }) };
    signers.set(envName, s);
  }
  return s;
}

export const oracleSigner = () => signer("ORACLE_PRIVATE_KEY");
export const relayerSigner = () => signer("RELAYER_PRIVATE_KEY");
export const agentServerSigner = () => signer("AGENT_SERVER_PRIVATE_KEY");

export function agentWorkerAddress(): `0x${string}` {
  return requireEnv("AGENT_WORKER_ADDRESS") as `0x${string}`;
}

export function dripAmountMon(): string {
  return requireEnv("DRIP_AMOUNT_MON");
}
