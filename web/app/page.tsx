"use client";

// Phone flow. Minimal functional UI; styling is owned by the UI teammate.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  addressUrl,
  CAUSE_LABELS,
  DEFAULT_STATION_ID,
  PHONE_POLL_DISRUPTED_MS,
  PHONE_POLL_MS,
  STATIONS,
  txUrl,
} from "@/lib/config";
import {
  BuyError,
  buyPass,
  ensureFunded,
  findPayoutTx,
  getOrCreateBurner,
  getPayoutAmount,
  getPolicy,
  getPremium,
  getStatuses,
  weiToRupees,
} from "@/lib/fastlocal";
import type { Cause, PhoneState, PolicyView, StationStatus } from "@/lib/types";

type StationState = { status: StationStatus; cause: Cause };
type Boot = "creating" | "funding" | "error" | "done";

const STATION_PREF = "fastlocal:station";
const MAX_BACKOFF_MS = 15_000;

export default function PhonePage() {
  const [boot, setBoot] = useState<Boot>("creating");
  const [bootError, setBootError] = useState<string | null>(null);
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const [isNewWallet, setIsNewWallet] = useState(false);

  const [stationId, setStationId] = useState(DEFAULT_STATION_ID);
  const [stations, setStations] = useState<StationState[] | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [premium, setPremium] = useState<bigint | null>(null);
  const [payoutAmount, setPayoutAmount] = useState<bigint | null>(null);
  const [rpcTrouble, setRpcTrouble] = useState(false);
  const [nowSec, setNowSec] = useState(0); // updated on each poll

  const [buying, setBuying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [buyTx, setBuyTx] = useState<string | null>(null);
  const [payoutTx, setPayoutTx] = useState<string | null>(null);
  const [wantNewPass, setWantNewPass] = useState(false);
  const failures = useRef(0);

  // ---------- Boot: burner wallet + gas drip ----------
  const start = useCallback(async () => {
    setBootError(null);
    setBoot("creating");
    const saved = savedStation();
    if (saved !== null) setStationId(saved);
    try {
      const { account, isNew } = getOrCreateBurner(); // key is saved before the drip starts
      setAccount(account);
      setIsNewWallet(isNew);
      setBoot("funding");
      await ensureFunded(account.address);
      setBoot("done");
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
      setBoot("error");
    }
  }, []);

  // Boot once on mount. The sync setState calls in start() only reset flags and restore the saved station.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    start();
  }, [start]);

  const chooseStation = (id: number) => {
    setStationId(id);
    setNotice(null);
    try {
      localStorage.setItem(STATION_PREF, String(id));
    } catch {}
  };

  // ---------- Chain reads (one multicall per poll) ----------
  const refresh = useCallback(async () => {
    if (!account) return;
    const [s, p, pr, pay] = await Promise.all([
      getStatuses(),
      getPolicy(account.address),
      getPremium(stationId),
      getPayoutAmount(),
    ]);
    setStations(s);
    setPolicy(p);
    setPremium(pr);
    setPayoutAmount(pay);
    setNowSec(Math.floor(Date.now() / 1000));
    return { s, p };
  }, [account, stationId]);

  // Poll every 3 s, every 1 s while the watched station is DISRUPTED. Back off on RPC errors.
  useEffect(() => {
    if (boot !== "done" || !account) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      let delay = PHONE_POLL_MS;
      try {
        const r = await refresh();
        failures.current = 0;
        setRpcTrouble(false);
        const watched = r?.p && r.p.active && !r.p.paid ? r.p.stationId : stationId;
        if (r?.s[watched]?.status === "DISRUPTED") delay = PHONE_POLL_DISRUPTED_MS;
      } catch {
        failures.current++;
        setRpcTrouble(true);
        delay = Math.min(MAX_BACKOFF_MS, PHONE_POLL_MS * 2 ** failures.current);
      }
      if (!stopped) timer = setTimeout(loop, delay);
    };
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [boot, account, stationId, refresh]);

  // Find the payout tx once the policy flips to paid.
  useEffect(() => {
    if (!account || !policy?.paid || payoutTx) return;
    findPayoutTx(account.address, policy.paidBlock).then((h) => h && setPayoutTx(h));
  }, [account, policy?.paid, policy?.paidBlock, payoutTx]);

  // ---------- Buy ----------
  const onBuy = async () => {
    if (!account || buying) return; // double tap guard
    setBuying(true);
    setNotice(null);
    try {
      const { hash } = await buyPass(account, stationId);
      setBuyTx(hash);
      setPayoutTx(null);
      setWantNewPass(false);
    } catch (err) {
      const e = err instanceof BuyError ? err : new BuyError("UNKNOWN", String(err));
      if (e.kind === "LOW_BALANCE") {
        try {
          await ensureFunded(account.address); // only helps brand-new wallets
        } catch {}
      }
      setNotice(e.message);
    } finally {
      await refresh().catch(() => {});
      setBuying(false);
    }
  };

  // ---------- Derived phone state ----------
  const hasActivePass = !!policy && policy.active && !policy.paid && policy.expiry > nowSec;
  const expired = !!policy && policy.active && !policy.paid && policy.expiry <= nowSec;
  const selected = stations?.[stationId];

  let state: PhoneState;
  if (boot === "creating") state = "creating";
  else if (boot === "funding") state = "funding";
  else if (boot === "error") state = "error";
  else if (buying) state = "buying";
  else if (policy?.paid && !wantNewPass) state = "paid";
  else if (hasActivePass) state = "protected";
  else if (selected?.status === "DISRUPTED") state = "closed";
  else state = "ready";

  const station = STATIONS[stationId];
  const policyStation = policy ? STATIONS[policy.stationId] : null;
  const policyStationState = policy ? stations?.[policy.stationId] : undefined;
  const payoutRs = payoutAmount !== null ? weiToRupees(payoutAmount) : 300;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 bg-neutral-950 p-6 text-neutral-100">
      <header>
        <h1 className="text-3xl font-bold">FastLocal</h1>
        <p className="text-neutral-400">When the local stops, FastLocal pays.</p>
      </header>

      {rpcTrouble && (
        <p className="rounded bg-amber-900/40 p-2 text-sm text-amber-200">Network is slow. Retrying…</p>
      )}

      {state === "creating" && <p className="text-lg">Creating your demo wallet…</p>}

      {state === "funding" && (
        <p className="text-lg">Adding a little gas to your demo wallet… (takes a few seconds)</p>
      )}

      {state === "error" && (
        <section className="flex flex-col gap-3">
          <p className="rounded bg-red-900/40 p-3 text-red-200">{bootError}</p>
          <button className="rounded-xl bg-purple-600 p-4 text-lg font-semibold" onClick={start}>
            Retry
          </button>
        </section>
      )}

      {(state === "ready" || state === "closed") && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-neutral-400">Your station</span>
            <select
              className="rounded-xl bg-neutral-800 p-4 text-lg"
              value={stationId}
              onChange={(e) => chooseStation(Number(e.target.value))}
            >
              {STATIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.line}) {stations ? `: ${stations[s.id].status}` : ""}
                </option>
              ))}
            </select>
          </label>

          <StationLine name={station.name} s={selected} />

          {expired && <p className="text-sm text-neutral-400">Your last pass expired. You can buy a new one.</p>}

          {state === "closed" ? (
            <p className="rounded bg-red-900/40 p-4 text-lg text-red-200">
              Sales closed at {station.name}
              {selected && selected.cause !== "NONE" ? ` (${CAUSE_LABELS[selected.cause]})` : ""}.
            </p>
          ) : (
            <>
              {selected?.status === "ALERT" && (
                <p className="rounded bg-amber-900/40 p-3 text-amber-200">
                  High risk ({CAUSE_LABELS[selected.cause]}): price is 2x right now.
                </p>
              )}
              <button
                className="rounded-xl bg-purple-600 p-5 text-xl font-bold disabled:opacity-50"
                onClick={onBuy}
                disabled={premium === null || !stations}
              >
                Protect My Ride{premium !== null ? ` · Rs ${weiToRupees(premium)}` : ""}
              </button>
              <p className="text-sm text-neutral-400">
                If service stops at {station.name}, Rs {payoutRs} lands in your wallet automatically. No claim.
              </p>
            </>
          )}
          {notice && <p className="rounded bg-neutral-800 p-3 text-amber-200">{notice}</p>}
        </section>
      )}

      {state === "buying" && <p className="text-lg">Protecting your ride…</p>}

      {state === "protected" && policy && policyStation && (
        <section className="flex flex-col gap-3">
          <p className="text-2xl font-bold text-purple-300">Your ride is protected</p>
          <StationLine name={policyStation.name} s={policyStationState} />
          {policyStationState?.status === "DISRUPTED" ? (
            <p className="text-lg text-red-300">Disruption detected. Your Rs {payoutRs} relief is on its way…</p>
          ) : (
            <p className="text-neutral-300">
              If service stops at {policyStation.name}, Rs {payoutRs} lands here automatically.
            </p>
          )}
          <p className="text-sm text-neutral-500">
            Valid until {new Date(policy.expiry * 1000).toLocaleString()}
          </p>
          {buyTx && (
            <a className="text-sm text-purple-300 underline" href={txUrl(buyTx)} target="_blank" rel="noreferrer">
              View pass transaction
            </a>
          )}
          {notice && <p className="rounded bg-neutral-800 p-3 text-amber-200">{notice}</p>}
        </section>
      )}

      {state === "paid" && policy && policyStation && (
        <section className="flex flex-col gap-3 rounded-xl bg-green-700 p-5">
          <p className="text-3xl font-bold">Rs {payoutRs} relief received</p>
          <p>
            {policyStation.name}
            {policyStationState && policyStationState.cause !== "NONE"
              ? `: ${CAUSE_LABELS[policyStationState.cause]}`
              : ""}
          </p>
          <a
            className="underline"
            href={payoutTx ? txUrl(payoutTx) : account ? addressUrl(account.address) : "#"}
            target="_blank"
            rel="noreferrer"
          >
            {payoutTx ? "View payout transaction" : "View on explorer"}
          </a>
          <button className="rounded-xl bg-neutral-900 p-4 font-semibold" onClick={() => setWantNewPass(true)}>
            Protect another ride
          </button>
        </section>
      )}

      {account && (
        <footer className="mt-auto text-xs text-neutral-500">
          Demo wallet{isNewWallet ? " (new)" : ""}:{" "}
          <a className="underline" href={addressUrl(account.address)} target="_blank" rel="noreferrer">
            {account.address.slice(0, 6)}…{account.address.slice(-4)}
          </a>{" "}
          · testnet MON at a demo rate (0.0001 MON = Rs 1)
        </footer>
      )}
    </main>
  );
}

function savedStation(): number | null {
  try {
    const raw = localStorage.getItem(STATION_PREF);
    const id = Number(raw);
    return raw !== null && Number.isInteger(id) && id >= 0 && id < STATIONS.length ? id : null;
  } catch {
    return null;
  }
}

function StationLine({ name, s }: { name: string; s?: StationState }) {
  if (!s) return <p className="text-neutral-400">{name}: loading…</p>;
  const color = s.status === "DISRUPTED" ? "text-red-400" : s.status === "ALERT" ? "text-amber-400" : "text-neutral-300";
  return (
    <p className={`text-lg ${color}`}>
      {name}: {s.status}
      {s.cause !== "NONE" ? ` · ${CAUSE_LABELS[s.cause]}` : ""}
    </p>
  );
}
