"use client";

// Phone flow. One clear card per state; logic above the JSX is unchanged.
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
  friendlyError,
  getOrCreateBurner,
  getPayoutAmount,
  getPolicy,
  getPremium,
  getStatuses,
  weiToRupees,
} from "@/lib/fastlocal";
import type { Cause, PhoneState, PolicyView, StationStatus } from "@/lib/types";
import {
  CauseIcon,
  CheckIcon,
  LiveDot,
  ShieldIcon,
  Spinner,
  StationBoard,
  STATUS_LABEL,
  StatusDot,
  StatusPill,
  TrainMark,
} from "@/components/ui";

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
      setBootError(friendlyError(err));
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

  const premiumRs = premium !== null ? weiToRupees(premium) : null;
  const policyDisrupted = policyStationState?.status === "DISRUPTED";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-5 pb-8 pt-6">
      <header className="mb-6 flex items-center gap-3">
        <TrainMark />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">FastLocal</h1>
          <p className="text-sm text-muted">When the local stops, FastLocal pays.</p>
        </div>
      </header>

      {rpcTrouble && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-400/30">
          <Spinner className="h-4 w-4" /> Network is slow. Retrying…
        </div>
      )}

      <div aria-live="polite" className="flex flex-1 flex-col gap-5">
        {(state === "creating" || state === "funding") && <SetupCard state={state} />}

        {state === "error" && (
          <section className="rise-in rounded-3xl bg-rose-500/10 p-5 ring-1 ring-rose-400/40">
            <p className="text-lg font-bold text-rose-100">Something went wrong</p>
            <p className="mt-1 break-words text-rose-200/90">{bootError}</p>
            <button className={PRIMARY_BUTTON} onClick={start}>
              Try again
            </button>
          </section>
        )}

        {(state === "ready" || state === "closed") && (
          <section className="rise-in flex flex-col gap-5">
            <div>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted">Where do you board?</h2>
              <StationPicker stations={stations} selectedId={stationId} onPick={chooseStation} />
            </div>

            {state === "closed" ? (
              <div className="relative overflow-hidden rounded-3xl bg-rose-500/10 p-5 ring-1 ring-rose-400/40">
                {selected?.cause === "RAIN_FLOOD" && <div className="rain absolute inset-0" />}
                <div className="relative flex flex-col items-start gap-3">
                  <StationBoard name={station.name} />
                  <p className="text-2xl font-extrabold text-rose-100">Sales closed at {station.name}</p>
                  {selected && selected.cause !== "NONE" && (
                    <p className="flex items-center gap-2 font-medium text-rose-200">
                      <CauseIcon cause={selected.cause} /> {CAUSE_LABELS[selected.cause]}
                    </p>
                  )}
                  <p className="text-sm text-muted">Service is stopped here right now. Pick another station to get covered.</p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl bg-card p-5 ring-1 ring-line">
                <div className="flex items-center justify-between gap-3">
                  <StationBoard name={station.name} />
                  {selected && <StatusPill status={selected.status} />}
                </div>
                {selected?.status === "ALERT" && (
                  <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-amber-400/30">
                    <CauseIcon cause={selected.cause} className="mt-0.5 h-5 w-5 shrink-0" />
                    <span>
                      <b>{CAUSE_LABELS[selected.cause]}</b> risk right now, so cover costs 2x.
                    </span>
                  </p>
                )}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Figure label="You pay" value={premiumRs !== null ? `Rs ${premiumRs}` : "…"} />
                  <Figure label="If service stops" value={`Rs ${payoutRs}`} accent />
                </div>
                <p className="mt-3 text-sm text-muted">
                  Covers you at {station.name} for 24 hours. Paid out automatically. No claim.
                </p>
                {expired && <p className="mt-2 text-sm text-muted">Your last pass expired. Buy a fresh one below.</p>}
                <button className={PRIMARY_BUTTON} onClick={onBuy} disabled={premium === null || !stations}>
                  Protect My Ride{premiumRs !== null ? ` · Rs ${premiumRs}` : ""}
                </button>
              </div>
            )}
            {notice && <Notice text={notice} />}
          </section>
        )}

        {state === "buying" && (
          <section className="rise-in flex flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center ring-1 ring-line">
            <Spinner className="h-10 w-10 text-monsoon" />
            <p className="text-xl font-bold">Protecting your ride…</p>
            <p className="text-sm text-muted">Confirming your pass on Monad. This takes a moment.</p>
          </section>
        )}

        {state === "protected" && policy && policyStation && (
          <section className="rise-in flex flex-col gap-4">
            <div
              className={`relative overflow-hidden rounded-3xl p-5 ring-1 ${
                policyDisrupted ? "bg-rose-500/10 ring-rose-400/50" : "bg-card ring-monsoon/40"
              }`}
            >
              {policyDisrupted && policyStationState?.cause === "RAIN_FLOOD" && <div className="rain absolute inset-0" />}
              <div className="relative">
                <div className="flex items-center justify-between gap-3">
                  <StationBoard name={policyStation.name} />
                  {policyStationState && <StatusPill status={policyStationState.status} />}
                </div>

                {policyDisrupted && policyStationState ? (
                  <div className="mt-5">
                    <p className="text-2xl font-extrabold text-rose-100">Service stopped</p>
                    {policyStationState.cause !== "NONE" && (
                      <p className="mt-1 flex items-center gap-2 font-medium text-rose-200">
                        <CauseIcon cause={policyStationState.cause} /> {CAUSE_LABELS[policyStationState.cause]}
                      </p>
                    )}
                    <p className="mt-4 text-lg font-semibold">Your Rs {payoutRs} relief is on its way…</p>
                    <div className="progress-run mt-3 h-1.5 w-full rounded-full bg-white/10" />
                  </div>
                ) : (
                  <div className="mt-5">
                    <div className="flex items-center gap-3">
                      <ShieldIcon className="h-11 w-11 text-monsoon" />
                      <div>
                        <p className="text-2xl font-extrabold">Ride protected</p>
                        <p className="flex items-center gap-2 text-sm text-muted">
                          <LiveDot /> Watching {policyStation.name} live
                        </p>
                      </div>
                    </div>
                    <p className="mt-4 text-muted">
                      If service stops, <b className="text-white">Rs {payoutRs}</b> lands in your wallet automatically.
                    </p>
                  </div>
                )}

                <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-dashed border-line pt-4 text-sm">
                  <div>
                    <dt className="text-muted">Valid until</dt>
                    <dd className="font-semibold">
                      {new Date(policy.expiry * 1000).toLocaleString([], {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Cover</dt>
                    <dd className="font-semibold">Rs {payoutRs}</dd>
                  </div>
                </dl>
                {buyTx && (
                  <a className="mt-4 inline-block text-sm font-medium text-monsoon hover:underline" href={txUrl(buyTx)} target="_blank" rel="noreferrer">
                    View pass transaction ↗
                  </a>
                )}
              </div>
            </div>
            {notice && <Notice text={notice} />}
          </section>
        )}

        {state === "paid" && policy && policyStation && (
          <section className="rise-in relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-400 to-teal-600 p-6 text-emerald-950 shadow-[0_20px_60px_-20px_rgba(16,185,129,0.8)]">
            <div className="pop-in mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/90">
              <CheckIcon className="h-9 w-9 text-emerald-600" />
            </div>
            <p className="mt-4 text-center text-sm font-bold uppercase tracking-widest">Relief received</p>
            <p className="text-center text-6xl font-black tracking-tight">Rs {payoutRs}</p>
            <p className="mt-2 text-center font-medium">
              {policyStation.name}
              {policyStationState && policyStationState.cause !== "NONE" ? ` · ${CAUSE_LABELS[policyStationState.cause]}` : ""}. No claim needed.
            </p>
            <a
              className="mt-5 block rounded-2xl bg-emerald-950/15 px-4 py-3 text-center font-semibold hover:bg-emerald-950/25"
              href={payoutTx ? txUrl(payoutTx) : account ? addressUrl(account.address) : "#"}
              target="_blank"
              rel="noreferrer"
            >
              {payoutTx ? "View payout transaction ↗" : "View on explorer ↗"}
            </a>
            <button
              className="mt-3 w-full rounded-2xl bg-emerald-950 px-4 py-4 font-bold text-emerald-50 transition active:scale-[0.98]"
              onClick={() => setWantNewPass(true)}
            >
              Protect another ride
            </button>
          </section>
        )}
      </div>

      {account && (
        <footer className="mt-8 flex flex-col items-center gap-2 text-center text-xs text-muted">
          <a
            className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 ring-1 ring-line hover:ring-monsoon/50"
            href={addressUrl(account.address)}
            target="_blank"
            rel="noreferrer"
          >
            <span className="h-2 w-2 rounded-full bg-monsoon" />
            Demo wallet{isNewWallet ? " (new)" : ""} · {account.address.slice(0, 6)}…{account.address.slice(-4)}
          </a>
          <span>Monad testnet · demo rate 0.0001 MON = Rs 1</span>
        </footer>
      )}
    </main>
  );
}

const PRIMARY_BUTTON =
  "mt-5 w-full rounded-2xl bg-monsoon px-5 py-4 text-lg font-bold text-ink shadow-[0_10px_30px_-10px_rgba(56,189,248,0.8)] transition hover:bg-monsoon-soft active:scale-[0.98] disabled:opacity-50";

function SetupCard({ state }: { state: "creating" | "funding" }) {
  const steps = [
    { label: "Create your demo wallet", status: state === "creating" ? "active" : "done" },
    { label: "Add a little gas, free", status: state === "funding" ? "active" : "pending" },
    { label: "Pick your station", status: "pending" },
  ] as const;
  return (
    <section className="rise-in rounded-3xl bg-card p-6 ring-1 ring-line">
      <p className="text-xl font-bold">Getting you ready</p>
      <p className="mt-1 text-sm text-muted">No app, no crypto wallet needed. Takes a few seconds.</p>
      <ol className="mt-5 flex flex-col gap-4">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-3">
            {s.status === "done" ? (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
                <CheckIcon className="h-4 w-4" />
              </span>
            ) : s.status === "active" ? (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-monsoon/15 text-monsoon">
                <Spinner className="h-4 w-4" />
              </span>
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/5 ring-1 ring-line" />
            )}
            <span className={s.status === "pending" ? "text-muted" : "font-medium"}>{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StationPicker({
  stations,
  selectedId,
  onPick,
}: {
  stations: StationState[] | null;
  selectedId: number;
  onPick: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Station">
      {STATIONS.map((s) => {
        const status = stations?.[s.id]?.status ?? "CLEAR";
        const active = s.id === selectedId;
        return (
          <button
            key={s.id}
            role="radio"
            aria-checked={active}
            onClick={() => onPick(s.id)}
            className={`flex min-h-16 flex-col items-start justify-between gap-1 rounded-2xl p-3 text-left transition active:scale-[0.97] ${
              active ? "bg-card-2 ring-2 ring-monsoon" : "bg-card ring-1 ring-line hover:ring-monsoon/50"
            }`}
          >
            <span className="font-bold">{s.name}</span>
            <span className="flex items-center gap-1.5 text-[11px] leading-none text-muted">
              <StatusDot status={status} className="scale-75" />
              {stations ? STATUS_LABEL[status] : "…"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Figure({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-ink/60 p-3 ring-1 ring-line">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${accent ? "text-emerald-300" : ""}`}>{value}</p>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-amber-400/30">
      {text}
    </p>
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
