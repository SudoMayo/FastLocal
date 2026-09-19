"use client";

// Operator + big screen. Minimal functional UI; styling is owned by the UI teammate.
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

  if (!passcode) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
        <form
          className="flex w-full max-w-sm flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            writePass(passInput.trim());
          }}
        >
          <h1 className="text-2xl font-bold">FastLocal operator</h1>
          <input
            className="rounded bg-neutral-800 p-3"
            type="password"
            placeholder="Admin passcode"
            value={passInput}
            onChange={(e) => setPassInput(e.target.value)}
          />
          <button className="rounded bg-purple-600 p-3 font-semibold">Enter</button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 p-6 text-neutral-100">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-5xl font-bold">FastLocal</h1>
          <p className="text-xl text-neutral-400">When the local stops, FastLocal pays.</p>
          {rpcTrouble && <p className="mt-2 text-amber-300">RPC slow, retrying…</p>}
        </div>
        {origin && (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-3 text-neutral-900">
            <QRCodeSVG value={origin} size={160} />
            <span className="text-sm font-semibold">Scan to protect your ride</span>
          </div>
        )}
      </header>

      {shownProof && (
        <p className="mb-6 rounded-xl bg-green-800 p-5 text-4xl font-bold">
          All {shownProof.count} payouts landed within {shownProof.blocks} blocks (
          {shownProof.seconds < 1 ? "under 1 s" : `${shownProof.seconds} s`})
        </p>
      )}
      {selected && selected.snapshot.status === "DISRUPTED" && selected.eligibleUnpaid > 0 && (
        <p className="mb-6 rounded-xl bg-red-900 p-5 text-3xl font-bold">
          {STATIONS[stationId].name}: {selected.paidThisDisruption} paid, {selected.eligibleUnpaid} waiting…
        </p>
      )}

      <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        {STATIONS.map((st) => {
          const s = stats?.[st.id];
          const status = s?.snapshot.status ?? "CLEAR";
          const color = status === "DISRUPTED" ? "bg-red-900 animate-pulse" : status === "ALERT" ? "bg-amber-800" : "bg-neutral-800";
          return (
            <button
              key={st.id}
              className={`rounded-xl p-4 text-left ${color} ${st.id === stationId ? "ring-4 ring-purple-500" : ""}`}
              onClick={() => setStationId(st.id)}
            >
              <div className="text-2xl font-bold">{st.name}</div>
              <div className="text-lg">
                {status}
                {s && s.snapshot.cause !== "NONE" ? ` · ${CAUSE_LABELS[s.snapshot.cause]}` : ""}
              </div>
              <div className="mt-2 text-5xl font-bold">{s?.protectedCount ?? "–"}</div>
              <div className="text-sm text-neutral-300">protected now</div>
              <div className="mt-1 text-2xl font-semibold text-green-300">{s?.paidThisDisruption ?? "–"}</div>
              <div className="text-sm text-neutral-300">paid (last disruption)</div>
            </button>
          );
        })}
      </section>

      <section className="mb-8 flex flex-col gap-3 rounded-xl bg-neutral-900 p-4">
        <h2 className="text-xl font-semibold">Controls: {STATIONS[stationId].name}</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select className="rounded bg-neutral-800 p-3" value={stationId} onChange={(e) => setStationId(Number(e.target.value))}>
            {STATIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select className="rounded bg-neutral-800 p-3" value={cause} onChange={(e) => setCause(e.target.value as Cause)}>
            {CAUSES.filter((c) => c !== "NONE").map((c) => (
              <option key={c} value={c}>
                {CAUSE_LABELS[c]}
              </option>
            ))}
          </select>
          <button className="rounded bg-amber-600 px-5 py-3 font-bold disabled:opacity-50" disabled={!!busy} onClick={() => setStation("ALERT")}>
            {busy === "ALERT" ? "…" : "ALERT"}
          </button>
          <button className="rounded bg-red-600 px-5 py-3 font-bold disabled:opacity-50" disabled={!!busy} onClick={() => setStation("DISRUPTED")}>
            {busy === "DISRUPTED" ? "…" : "DISRUPT"}
          </button>
          <button
            className="rounded bg-neutral-600 px-5 py-3 font-bold disabled:opacity-50"
            disabled={!!busy || clearBlocked}
            onClick={() => setStation("CLEAR")}
          >
            {busy === "CLEAR" ? "…" : "CLEAR"}
          </button>
          <button className="rounded bg-purple-600 px-5 py-3 font-bold disabled:opacity-50" disabled={!!busy} onClick={runPayouts}>
            {busy === "PAYOUT" ? "Paying…" : "Run payouts now"}
          </button>
        </div>
        {selected && selected.snapshot.status === "DISRUPTED" && selected.eligibleUnpaid > 0 && (
          <label className="flex items-center gap-2 text-amber-300">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            {selected.eligibleUnpaid} eligible passes are unpaid. Force CLEAR anyway.
          </label>
        )}
        {message && (
          <p className="text-neutral-200">
            {message}{" "}
            {lastTx && (
              <a className="text-purple-300 underline" href={txUrl(lastTx)} target="_blank" rel="noreferrer">
                tx
              </a>
            )}
          </p>
        )}
      </section>

      <section className="rounded-xl bg-neutral-900 p-4">
        <h2 className="mb-2 text-xl font-semibold">Health</h2>
        {health ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="Vault" value={`${fmt(health.vaultMon)} MON`} />
            <Stat label="Vault covers" value={`${health.vaultCoverage} payouts`} />
            <Stat label="Relayer" value={`${fmt(health.relayerMon)} MON`} />
            <Stat label="Agent worker" value={`${fmt(health.agentWorkerMon)} MON`} />
            <Stat label="Agent fallback" value={`${fmt(health.agentServerMon)} MON`} />
          </div>
        ) : (
          <p className="text-neutral-400">Loading…</p>
        )}
        {warnings.map((w) => (
          <p key={w} className="mt-2 rounded bg-amber-900/50 p-2 text-amber-200">
            {w}
          </p>
        ))}
        <button className="mt-4 text-sm text-neutral-500 underline" onClick={() => writePass("")}>
          Lock screen
        </button>
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
    <div className="rounded bg-neutral-800 p-3">
      <div className="text-sm text-neutral-400">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
