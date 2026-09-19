"use client";

// Operator + big screen (projector). Logic above the JSX is unchanged.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  CAUSE_LABELS,
  CAUSES,
  DEFAULT_STATION_ID,
  SCREEN_HEALTH_POLL_MS,
  SCREEN_SNAPSHOT_POLL_MS,
  STATIONS,
  txUrl,
} from "@/lib/config";
import { isPolicyEligible } from "@/lib/contract";
import { getAllSnapshots, getBlockTime } from "@/lib/fastlocal";
import type { Cause, Health, StationSnapshot, StationStatus } from "@/lib/types";
import {
  CauseIcon,
  CheckIcon,
  LiveDot,
  Spinner,
  StationBoard,
  StatusPill,
  TrainMark,
} from "@/components/ui";

// Thresholds for health warnings.
const RELAYER_MIN_MON = 10.5; // 10 MON Monad reserve + room for drips
const AGENT_WORKER_MIN_MON = 0.5;
const AGENT_SERVER_MIN_MON = 0.3;

// ---------- Passcode in sessionStorage ----------
const PASS_KEY = "fastlocal:passcode";
const passListeners = new Set<() => void>();
function readPass(): string {
  try {
    return sessionStorage.getItem(PASS_KEY) ?? "";
  } catch {
    return "";
  }
}
function writePass(value: string) {
  try {
    if (value) sessionStorage.setItem(PASS_KEY, value);
    else sessionStorage.removeItem(PASS_KEY);
  } catch {}
  passListeners.forEach((l) => l());
}
function subscribePass(cb: () => void) {
  passListeners.add(cb);
  return () => {
    passListeners.delete(cb);
  };
}
const noopSubscribe = () => () => {};

type StationStats = {
  snapshot: StationSnapshot;
  protectedCount: number;
  eligibleUnpaid: number;
  paidThisDisruption: number;
  maxPaidBlock: number;
};

type Proof = { stationId: number; count: number; blocks: number; seconds: number };

export default function ScreenPage() {
  const passcode = useSyncExternalStore(subscribePass, readPass, () => "");
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const [passInput, setPassInput] = useState("");

  const [stats, setStats] = useState<StationStats[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [rpcTrouble, setRpcTrouble] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);

  const [stationId, setStationId] = useState(DEFAULT_STATION_ID);
  const [cause, setCause] = useState<Cause>("RAIN_FLOOD");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  // ---------- Snapshot poll (2 s) ----------
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const loop = async () => {
      try {
        const { snapshots, nowSec, waitingPeriod } = await getAllSnapshots();
        setStats(snapshots.map((s) => summarize(s, nowSec, waitingPeriod)));
        setRpcTrouble(false);
        failures = 0;
      } catch {
        failures++;
        setRpcTrouble(true);
      }
      if (!stopped) timer = setTimeout(loop, Math.min(15_000, SCREEN_SNAPSHOT_POLL_MS * 2 ** failures));
    };
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // ---------- Health poll (10 s) ----------
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setHealth(data);
        setHealthError(null);
      } catch (err) {
        setHealthError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(loop, SCREEN_HEALTH_POLL_MS);
    };
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // ---------- Speed proof: max(paidBlock) - disruptedAtBlock, and block timestamps ----------
  const selected = stats?.[stationId];
  const proofKey =
    selected && selected.paidThisDisruption > 0 && selected.eligibleUnpaid === 0
      ? `${stationId}:${selected.snapshot.disruptedAtBlock}:${selected.maxPaidBlock}:${selected.paidThisDisruption}`
      : null;
  useEffect(() => {
    if (!proofKey || !selected) return;
    const from = selected.snapshot.disruptedAtBlock;
    const to = selected.maxPaidBlock;
    const count = selected.paidThisDisruption;
    let cancelled = false;
    Promise.all([getBlockTime(from), getBlockTime(to)])
      .then(([t0, t1]) => {
        if (!cancelled) setProof({ stationId, count, blocks: to - from, seconds: t1 - t0 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // proofKey captures every value used above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofKey]);

  // ---------- Admin actions ----------
  const post = useCallback(
    async (url: string, body: object) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) writePass(""); // ask again
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    [passcode],
  );

  const setStation = async (status: StationStatus) => {
    setBusy(status);
    setMessage(null);
    try {
      const data = await post("/api/admin/station", {
        stationId,
        status,
        cause: status === "CLEAR" ? "NONE" : cause,
        force: status === "CLEAR" ? force : false,
      });
      setLastTx(data.txHash);
      setMessage(`${STATIONS[stationId].name} -> ${status}${status !== "CLEAR" ? ` (${CAUSE_LABELS[cause]})` : ""} in block ${data.blockNumber}`);
      setForce(false);
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runPayouts = async () => {
    setBusy("PAYOUT");
    setMessage(null);
    try {
      const r = await post("/api/admin/payout", { stationId });
      setLastTx(r.txHashes?.[0] ?? null);
      setMessage(
        r.eligible === 0
          ? `No eligible unpaid policies at ${STATIONS[stationId].name}.`
          : `Fallback paid ${r.paid} of ${r.eligible}${r.failed ? `, ${r.failed} failed` : ""}.`,
      );
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // ---------- Derived ----------
  const totalProtected = stats?.reduce((n, s) => n + s.protectedCount, 0) ?? 0;
  const warnings: string[] = [];
  if (health) {
    if (Number(health.relayerMon) < RELAYER_MIN_MON)
      warnings.push(`Relayer low (${fmt(health.relayerMon)} MON): drips fail below the 10 MON reserve.`);
    if (Number(health.agentWorkerMon) < AGENT_WORKER_MIN_MON) warnings.push(`Agent worker gas low (${fmt(health.agentWorkerMon)} MON).`);
    if (Number(health.agentServerMon) < AGENT_SERVER_MIN_MON) warnings.push(`Fallback agent gas low (${fmt(health.agentServerMon)} MON).`);
    if (health.vaultCoverage < totalProtected)
      warnings.push(`Vault covers ${health.vaultCoverage} payouts but ${totalProtected} passes are protected. Fund the vault.`);
  }
  if (healthError) warnings.push(`Health check failed: ${healthError}`);

  const clearBlocked = !!selected && selected.snapshot.status === "DISRUPTED" && selected.eligibleUnpaid > 0 && !force;
  const shownProof = proof && proof.stationId === stationId && proofKey ? proof : null;

  const totalPaid = stats?.reduce((n, s) => n + s.paidThisDisruption, 0) ?? 0;
  const selectedStatus = selected?.snapshot.status;
  const paying = !!selected && selected.snapshot.status === "DISRUPTED" && selected.eligibleUnpaid > 0;

  if (!passcode) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <form
          className="rise-in flex w-full max-w-sm flex-col gap-4 rounded-3xl bg-card p-7 ring-1 ring-line"
          onSubmit={(e) => {
            e.preventDefault();
            writePass(passInput.trim());
          }}
        >
          <div className="flex items-center gap-3">
            <TrainMark className="h-10 w-10" />
            <div>
              <h1 className="text-xl font-extrabold">FastLocal operator</h1>
              <p className="text-sm text-muted">Enter the admin passcode</p>
            </div>
          </div>
          <input
            className="rounded-xl bg-ink px-4 py-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-monsoon"
            type="password"
            placeholder="Admin passcode"
            autoFocus
            value={passInput}
            onChange={(e) => setPassInput(e.target.value)}
          />
          <button className="rounded-xl bg-monsoon py-3 font-bold text-ink transition hover:bg-monsoon-soft active:scale-[0.98]">
            Open screen
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1600px] px-6 py-6 lg:px-10">
      {/* ---------- Header + QR ---------- */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <TrainMark className="h-16 w-16" />
          <div>
            <h1 className="text-5xl font-black tracking-tight">FastLocal</h1>
            <p className="text-xl text-muted">When the local stops, FastLocal pays.</p>
          </div>
        </div>
        {origin && (
          <div className="flex items-center gap-4 rounded-3xl bg-white p-3 pr-6 text-ink shadow-[0_20px_60px_-25px_rgba(56,189,248,0.8)]">
            <QRCodeSVG value={origin} size={148} />
            <div>
              <p className="text-2xl font-extrabold leading-tight">Scan to protect</p>
              <p className="text-2xl font-extrabold leading-tight">your ride</p>
              <p className="mt-1 text-sm font-medium text-slate-600">Rs 10 cover · Rs 300 relief</p>
            </div>
          </div>
        )}
      </header>

      {rpcTrouble && (
        <p className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-2 text-amber-200 ring-1 ring-amber-400/30">
          <Spinner className="h-4 w-4" /> RPC slow, retrying…
        </p>
      )}

      {/* ---------- Hero: speed proof, live payout, or totals ---------- */}
      {shownProof ? (
        <section className="rise-in mb-6 flex flex-wrap items-center gap-5 rounded-3xl bg-gradient-to-r from-emerald-400 to-teal-500 p-6 text-emerald-950 shadow-[0_25px_70px_-30px_rgba(16,185,129,0.9)]">
          <span className="pop-in flex h-16 w-16 items-center justify-center rounded-full bg-white/90">
            <CheckIcon className="h-10 w-10 text-emerald-600" />
          </span>
          <div>
            <p className="text-lg font-bold uppercase tracking-widest">{STATIONS[shownProof.stationId].name} · paid on chain</p>
            <p className="text-4xl font-black lg:text-5xl">
              {shownProof.count === 1 ? "The payout" : `All ${shownProof.count} payouts`} landed within {shownProof.blocks} blocks (
              {shownProof.seconds < 1 ? "under 1 s" : `${shownProof.seconds} s`})
            </p>
          </div>
        </section>
      ) : paying && selected ? (
        <section className="rise-in relative mb-6 overflow-hidden rounded-3xl bg-rose-500/15 p-6 ring-2 ring-rose-400/60">
          {selected.snapshot.cause === "RAIN_FLOOD" && <div className="rain absolute inset-0" />}
          <div className="relative">
            <p className="flex items-center gap-2 text-lg font-bold uppercase tracking-widest text-rose-200">
              <CauseIcon cause={selected.snapshot.cause} /> {STATIONS[stationId].name} · {CAUSE_LABELS[selected.snapshot.cause]}
            </p>
            <p className="text-5xl font-black">
              {selected.paidThisDisruption} paid · {selected.eligibleUnpaid} on the way…
            </p>
            <div className="progress-run mt-4 h-2 w-full rounded-full bg-white/10" />
          </div>
        </section>
      ) : (
        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <BigStat label="Rides protected now" value={stats ? String(totalProtected) : "–"} />
          <BigStat label="Paid in last disruptions" value={stats ? String(totalPaid) : "–"} tone="emerald" />
          <BigStat label="Vault can pay" value={health ? `${health.vaultCoverage} more` : "–"} tone="monsoon" />
        </section>
      )}

      {/* ---------- Station tiles ---------- */}
      <section className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        {STATIONS.map((st) => {
          const s = stats?.[st.id];
          const status = s?.snapshot.status ?? "CLEAR";
          const tone =
            status === "DISRUPTED"
              ? "bg-rose-500/15 ring-rose-400/60"
              : status === "ALERT"
                ? "bg-amber-500/10 ring-amber-400/50"
                : "bg-card ring-line";
          return (
            <button
              key={st.id}
              onClick={() => setStationId(st.id)}
              className={`relative overflow-hidden rounded-3xl p-5 text-left ring-1 transition hover:brightness-110 ${tone} ${
                st.id === stationId ? "outline outline-4 outline-offset-2 outline-monsoon" : ""
              }`}
            >
              {status === "DISRUPTED" && s?.snapshot.cause === "RAIN_FLOOD" && <div className="rain absolute inset-0" />}
              <div className="relative">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StationBoard name={st.name} />
                  <StatusPill status={status} size="lg" />
                </div>
                <p className="mt-2 flex h-6 items-center gap-2 text-sm text-muted">
                  {s && s.snapshot.cause !== "NONE" ? (
                    <>
                      <CauseIcon cause={s.snapshot.cause} className="h-4 w-4" /> {CAUSE_LABELS[s.snapshot.cause]}
                    </>
                  ) : (
                    st.line
                  )}
                </p>
                <div className="mt-3 flex items-end gap-6">
                  <div>
                    <p className="text-6xl font-black leading-none">{s?.protectedCount ?? "–"}</p>
                    <p className="mt-1 text-sm text-muted">protected now</p>
                  </div>
                  <div>
                    <p className="text-4xl font-extrabold leading-none text-emerald-300">{s?.paidThisDisruption ?? "–"}</p>
                    <p className="mt-1 text-sm text-muted">paid (last disruption)</p>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </section>

      {/* ---------- Operator controls ---------- */}
      <section className="mb-6 rounded-3xl bg-card p-5 ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-3 text-xl font-bold">
            Operator <StationBoard name={STATIONS[stationId].name} size="sm" />
            {selectedStatus && <StatusPill status={selectedStatus} />}
          </h2>
          <select
            className="rounded-xl bg-ink px-3 py-2 ring-1 ring-line"
            value={stationId}
            onChange={(e) => setStationId(Number(e.target.value))}
            aria-label="Station"
          >
            {STATIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-widest text-muted">Cause</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cause">
          {CAUSES.filter((c) => c !== "NONE").map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={cause === c}
              onClick={() => setCause(c)}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ring-1 transition ${
                cause === c ? "bg-monsoon text-ink ring-monsoon" : "bg-ink text-slate-200 ring-line hover:ring-monsoon/50"
              }`}
            >
              <CauseIcon cause={c} className="h-4 w-4" /> {CAUSE_LABELS[c]}
            </button>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <ActionButton tone="amber" busy={busy === "ALERT"} disabled={!!busy} onClick={() => setStation("ALERT")}>
            Alert · 2x price
          </ActionButton>
          <ActionButton tone="rose" busy={busy === "DISRUPTED"} disabled={!!busy} onClick={() => setStation("DISRUPTED")}>
            Disrupt
          </ActionButton>
          <ActionButton tone="slate" busy={busy === "CLEAR"} disabled={!!busy || clearBlocked} onClick={() => setStation("CLEAR")}>
            Clear
          </ActionButton>
          <ActionButton tone="monsoon" busy={busy === "PAYOUT"} disabled={!!busy} onClick={runPayouts}>
            Run payouts now
          </ActionButton>
        </div>

        {selected && selected.snapshot.status === "DISRUPTED" && selected.eligibleUnpaid > 0 && (
          <label className="mt-4 flex items-center gap-2 text-amber-300">
            <input type="checkbox" className="h-4 w-4 accent-amber-400" checked={force} onChange={(e) => setForce(e.target.checked)} />
            {selected.eligibleUnpaid} eligible passes are unpaid. Force clear anyway.
          </label>
        )}
        {message && (
          <p className="mt-4 rounded-xl bg-ink px-4 py-3 text-slate-200 ring-1 ring-line">
            {message}{" "}
            {lastTx && (
              <a className="font-semibold text-monsoon hover:underline" href={txUrl(lastTx)} target="_blank" rel="noreferrer">
                View tx ↗
              </a>
            )}
          </p>
        )}
      </section>

      {/* ---------- Health ---------- */}
      <section className="rounded-3xl bg-card p-5 ring-1 ring-line">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <LiveDot className={warnings.length ? "bg-amber-400" : "bg-emerald-400"} /> System health
          </h2>
          <button className="text-sm text-muted hover:text-white" onClick={() => writePass("")}>
            Lock screen
          </button>
        </div>
        {health ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Vault" value={`${fmt(health.vaultMon)} MON`} />
            <Stat label="Vault covers" value={`${health.vaultCoverage} payouts`} />
            <Stat label="Relayer (gas drips)" value={`${fmt(health.relayerMon)} MON`} />
            <Stat label="Agent worker" value={`${fmt(health.agentWorkerMon)} MON`} />
            <Stat label="Agent fallback" value={`${fmt(health.agentServerMon)} MON`} />
          </div>
        ) : (
          <p className="text-muted">Loading…</p>
        )}
        {warnings.map((w) => (
          <p key={w} className="mt-3 rounded-xl bg-amber-500/10 px-4 py-2 text-amber-200 ring-1 ring-amber-400/30">
            {w}
          </p>
        ))}
      </section>
    </main>
  );
}

function summarize(snapshot: StationSnapshot, nowSec: number, waitingPeriod: number): StationStats {
  let protectedCount = 0;
  let eligibleUnpaid = 0;
  let paidThisDisruption = 0;
  let maxPaidBlock = 0;
  for (const { policy } of snapshot.buyers) {
    if (policy.active && !policy.paid && policy.expiry > nowSec) protectedCount++;
    if (isPolicyEligible(policy, snapshot.status, nowSec, waitingPeriod)) eligibleUnpaid++;
    if (policy.paid && snapshot.disruptedAtBlock > 0 && policy.paidBlock >= snapshot.disruptedAtBlock) {
      paidThisDisruption++;
      maxPaidBlock = Math.max(maxPaidBlock, policy.paidBlock);
    }
  }
  return { snapshot, protectedCount, eligibleUnpaid, paidThisDisruption, maxPaidBlock };
}

function fmt(mon: string): string {
  return Number(mon).toFixed(3);
}


function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-ink p-4 ring-1 ring-line">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function BigStat({ label, value, tone = "white" }: { label: string; value: string; tone?: "white" | "emerald" | "monsoon" }) {
  const color = tone === "emerald" ? "text-emerald-300" : tone === "monsoon" ? "text-monsoon" : "text-white";
  return (
    <div className="rounded-3xl bg-card p-5 ring-1 ring-line">
      <p className="text-sm font-semibold uppercase tracking-widest text-muted">{label}</p>
      <p className={`mt-1 text-6xl font-black ${color}`}>{value}</p>
    </div>
  );
}

const ACTION_TONES = {
  amber: "bg-amber-500 text-amber-950 hover:bg-amber-400",
  rose: "bg-rose-600 text-white hover:bg-rose-500",
  slate: "bg-slate-600 text-white hover:bg-slate-500",
  monsoon: "bg-monsoon text-ink hover:bg-monsoon-soft",
} as const;

function ActionButton({
  tone,
  busy,
  disabled,
  onClick,
  children,
}: {
  tone: keyof typeof ACTION_TONES;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`flex items-center justify-center gap-2 rounded-2xl px-4 py-4 text-lg font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${ACTION_TONES[tone]}`}
      disabled={disabled}
      onClick={onClick}
    >
      {busy && <Spinner className="h-5 w-5" />}
      {children}
    </button>
  );
}
