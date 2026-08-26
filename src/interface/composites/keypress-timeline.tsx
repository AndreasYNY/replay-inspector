import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OsuRenderer, OsuRendererEvents } from "@/osu/OsuRenderer";
import { GameplayAnalyzer } from "@/osu/GameplayAnalyzer";
import { state } from "@/utils";
import { ReplayButtonState } from "osu-classes";

type LaneDef = {
  id: string;
  label: string;
  readMask: number;
  writeBits: number[];
  color: string;
};

// Pick the single button bit to write per lane so edited presses group with
// the original key. In lazer M1 (Left1) and K1 (Left2) are separate inputs,
// so writing both breaks grouping; we write whichever the replay uses most.
function computeLanes(frames: any[]): LaneDef[] {
  let left1 = 0;
  let left2 = 0;
  let right1 = 0;
  let right2 = 0;
  for (const f of frames) {
    const b = f.buttonState ?? 0;
    if (b & ReplayButtonState.Left1) left1++;
    if (b & ReplayButtonState.Left2) left2++;
    if (b & ReplayButtonState.Right1) right1++;
    if (b & ReplayButtonState.Right2) right2++;
  }
  const leftBit = left2 > left1 ? ReplayButtonState.Left2 : ReplayButtonState.Left1;
  const rightBit = right2 > right1 ? ReplayButtonState.Right2 : ReplayButtonState.Right1;
  return [
    {
      id: "K1",
      label: "Key 1",
      readMask: ReplayButtonState.Left1 | ReplayButtonState.Left2,
      writeBits: [leftBit],
      color: "#22c55e",
    },
    {
      id: "K2",
      label: "Key 2",
      readMask: ReplayButtonState.Right1 | ReplayButtonState.Right2,
      writeBits: [rightBit],
      color: "#3b82f6",
    },
  ];
}

const JUDGEMENT_COLORS: Record<string, string> = {
  OK: "#eab308", // 100
  MEH: "#38bdf8", // 50
  MISS: "#ef4444", // miss
};

const JUDGEMENT_LABELS: Record<string, string> = {
  OK: "100",
  MEH: "50",
  MISS: "Miss",
};

type Segment = {
  uid: number;
  lane: number;
  start: number;
  end: number;
};

let uidCounter = 0;

function applyBits(frames: any[], bits: number[], start: number, end: number, on: boolean) {
  for (const f of frames) {
    if (f.startTime >= start && f.startTime <= end) {
      for (const bit of bits) {
        if (on) f.buttonState |= bit;
        else f.buttonState &= ~bit;
      }
    }
  }
}

// Recompute hit judgements (100/50/miss) after editing keyframes.
// Coalesces overlapping/rapid edits so we never run more than one heavy
// refreshMap at a time (prevents stutter + allocation buildup).
let _reanalyzing = false;
let _reanalyzePending = false;
function reanalyze() {
  if (_reanalyzing) {
    _reanalyzePending = true;
    return;
  }
  _reanalyzing = true;
  GameplayAnalyzer.refreshMap(OsuRenderer.beatmap, OsuRenderer.replay)
    .then(() => {
      OsuRenderer.event.emit(OsuRendererEvents.UPDATE);
    })
    .finally(() => {
      _reanalyzing = false;
      if (_reanalyzePending) {
        _reanalyzePending = false;
        reanalyze();
      }
    });
}

function computeSegments(frames: any[], lanes: LaneDef[]): Segment[] {
  const sorted = [...frames].sort((a, b) => a.startTime - b.startTime);
  const out: Segment[] = [];
  lanes.forEach((lane, laneIdx) => {
    const mask = lane.readMask;
    let inSeg = false;
    let segStart = 0;
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      const on = ((f.buttonState ?? 0) & mask) !== 0;
      if (on && !inSeg) {
        segStart = f.startTime;
        inSeg = true;
      } else if (!on && inSeg) {
        out.push({ uid: ++uidCounter, lane: laneIdx, start: segStart, end: sorted[i - 1].startTime });
        inSeg = false;
      }
    }
    if (inSeg) {
      out.push({ uid: ++uidCounter, lane: laneIdx, start: segStart, end: sorted[sorted.length - 1].startTime });
    }
  });
  return out;
}

// Isolated subscriber: only this tiny node re-renders every frame (the playhead),
// keeping the heavy timeline body from re-rendering on each time tick.
function TimelinePlayhead({
  viewStart,
  timeWindow,
  length,
  onRecenter,
}: {
  viewStart: number;
  timeWindow: number;
  length: number;
  onRecenter: (v: number) => void;
}) {
  const time = state((s) => s.time);

  useEffect(() => {
    const viewEnd = viewStart + timeWindow;
    if (time < viewStart || time > viewEnd) {
      const maxStart = Math.max(0, length - timeWindow);
      onRecenter(Math.max(0, Math.min(maxStart, time - timeWindow / 2)));
    }
  }, [time, viewStart, timeWindow, length, onRecenter]);

  if (time < viewStart || time > viewStart + timeWindow) return null;
  return (
    <div
      className="absolute top-0 bottom-0 w-[2px] bg-white/80 pointer-events-none z-20"
      style={{ left: `${((time - viewStart) / timeWindow) * 100}%` }}
    />
  );
}

type DragState = {
  uid: number;
  lane: number;
  bits: number[];
  mode: "move" | "left" | "right";
  startX: number;
  origStart: number;
  origEnd: number;
};

type PanState = {
  startX: number;
  startView: number;
  moved: boolean;
};

export function KeyTimeline() {
  const replay = state((s) => s.replay);
  const containerRef = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const [hover, setHover] = useState<Segment | null>(null);
  const [zoom, setZoom] = useState(100);
  const [viewStart, setViewStart] = useState(0);
  const [updateTick, setUpdateTick] = useState(0);

  const length = replay?.replay?.length ?? 0;
  const timeWindow = length / zoom;
  const viewEnd = Math.min(length, viewStart + timeWindow);

  const frames = useMemo(() => {
    if (!replay) return [];
    return (replay.replay?.frames as any[]) ?? [];
  }, [replay]);

  const lanes = useMemo(() => computeLanes(frames), [frames]);

  useEffect(() => {
    setSegments(computeSegments(frames, lanes));
  }, [frames, lanes]);

  useEffect(() => {
    const onUpdate = () => setUpdateTick((t) => t + 1);
    OsuRenderer.event.on(OsuRendererEvents.UPDATE, onUpdate);
    return () => {
      OsuRenderer.event.off(OsuRendererEvents.UPDATE, onUpdate);
    };
  }, []);

  const judgements = useMemo(() => {
    const raw = GameplayAnalyzer.renderJudgements || {};
    return Object.entries(raw)
      .map(([t, type]) => ({ time: Number(t), type: type as string }))
      .filter((j) => JUDGEMENT_COLORS[j.type]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateTick, replay]);

  const onRecenter = useCallback((v: number) => setViewStart(v), []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dxTime = ((e.clientX - drag.startX) / rect.width) * timeWindow;
      setSegments((prev) =>
        prev.map((s) => {
          if (s.uid !== drag.uid) return s;
          const minLen = 10;
          if (drag.mode === "move") {
            let ns = drag.origStart + dxTime;
            let ne = drag.origEnd + dxTime;
            if (ns < viewStart) {
              ne += viewStart - ns;
              ns = viewStart;
            }
            if (ne > viewEnd) {
              ns -= ne - viewEnd;
              ne = viewEnd;
            }
            return { ...s, start: ns, end: ne };
          }
          if (drag.mode === "left") {
            let ns = Math.min(drag.origStart + dxTime, drag.origEnd - minLen);
            ns = Math.max(viewStart, ns);
            return { ...s, start: ns };
          }
          let ne = Math.max(drag.origEnd + dxTime, drag.origStart + minLen);
          ne = Math.min(viewEnd, ne);
          return { ...s, end: ne };
        })
      );
    };
    const onUp = () => {
      const seg = segmentsRef.current.find((s) => s.uid === drag.uid);
      if (seg) {
        const bits = lanes[seg.lane].writeBits;
        applyBits(frames, bits, drag.origStart, drag.origEnd, false);
        applyBits(frames, bits, seg.start, seg.end, true);
        reanalyze();
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, timeWindow, viewStart, viewEnd, frames]);

  useEffect(() => {
    if (!pan) return;
    const onMove = (e: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dxTime = ((e.clientX - pan.startX) / rect.width) * timeWindow;
      if (Math.abs(e.clientX - pan.startX) > 4) {
        setPan((p) => (p ? { ...p, moved: true } : p));
      }
      const maxStart = Math.max(0, length - timeWindow);
      setViewStart(Math.max(0, Math.min(maxStart, pan.startView - dxTime)));
    };
    const onUp = (e: PointerEvent) => {
      if (!pan.moved && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const t = viewStart + ((e.clientX - rect.left) / rect.width) * timeWindow;
        OsuRenderer.setTime(t);
      }
      setPan(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pan, timeWindow, viewStart, length]);

  if (!replay || length <= 0) return null;

  const pct = (t: number) => `${((t - viewStart) / timeWindow) * 100}%`;

  const startDrag = (e: React.PointerEvent, seg: Segment, mode: DragState["mode"]) => {
    e.stopPropagation();
    setDrag({
      uid: seg.uid,
      lane: seg.lane,
      bits: lanes[seg.lane].writeBits,
      mode,
      startX: e.clientX,
      origStart: seg.start,
      origEnd: seg.end,
    });
  };

  const createSegment = (e: React.PointerEvent, laneIdx: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const t = viewStart + ((e.clientX - rect.left) / rect.width) * timeWindow;
    const dur = 150;
    const start = Math.max(viewStart, t - dur / 2);
    const end = Math.min(viewEnd, start + dur);
    applyBits(frames, lanes[laneIdx].writeBits, start, end, true);
    reanalyze();
    setSegments(computeSegments(frames));
  };

  const deleteSegment = (e: React.PointerEvent, seg: Segment) => {
    e.stopPropagation();
    applyBits(frames, lanes[seg.lane].writeBits, seg.start, seg.end, false);
    reanalyze();
    setSegments(computeSegments(frames));
  };

  const zoomBy = (factor: number) => {
    const newZoom = Math.max(1, Math.min(100, zoom * factor));
    const newWindow = length / newZoom;
    const center = OsuRenderer.time;
    let ns = center - newWindow / 2;
    ns = Math.max(0, Math.min(length - newWindow, ns));
    setZoom(newZoom);
    setViewStart(ns);
  };

  const visibleSegments = segments.filter((s) => s.end >= viewStart && s.start <= viewEnd);

  return (
    <div className="w-full select-none">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3 text-[10px]">
          <span className="opacity-50">Keypresses &amp; judgements:</span>
          {(["OK", "MEH", "MISS"] as const).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: JUDGEMENT_COLORS[t] }}
              />
              {JUDGEMENT_LABELS[t]}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="px-2 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20"
            onClick={() => zoomBy(1 / 1.5)}
          >
            −
          </button>
          <span className="text-xs tabular-nums w-12 text-center">{zoom.toFixed(1)}x</span>
          <button
            className="px-2 py-0.5 text-xs rounded bg-white/10 hover:bg-white/20"
            onClick={() => zoomBy(1.5)}
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative w-full h-[48px] rounded-md bg-black/30 overflow-hidden cursor-pointer"
        onPointerDown={(e) => {
          setPan({ startX: e.clientX, startView: viewStart, moved: false });
        }}
      >
        <TimelinePlayhead
          viewStart={viewStart}
          timeWindow={timeWindow}
          length={length}
          onRecenter={onRecenter}
        />
        {judgements
          .filter((j) => j.time >= viewStart && j.time <= viewEnd)
          .map((j, i) => {
            const isMiss = j.type === "MISS";
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0 pointer-events-none z-10"
                style={{
                  left: pct(j.time),
                  width: isMiss ? 3 : 2,
                  backgroundColor: JUDGEMENT_COLORS[j.type],
                  opacity: isMiss ? 1 : 0.85,
                }}
                title={JUDGEMENT_LABELS[j.type] ?? j.type}
              />
            );
          })}
        {lanes.map((k, lane) => (
          <div
            key={k.id}
            className="absolute left-0 right-0 border-b border-white/5"
            style={{ top: `${lane * 24}px`, height: "24px" }}
            onDoubleClick={(e) => createSegment(e, lane)}
            title={`${k.label} lane`}
          >
            <span
              className="absolute left-1 top-0.5 text-[10px] font-semibold z-10 pointer-events-none"
              style={{ color: k.color }}
            >
              {k.label}
            </span>
            {visibleSegments
              .filter((s) => s.lane === lane)
              .map((s) => {
                const isHover = hover?.uid === s.uid;
                const left = Math.max(0, (s.start - viewStart) / timeWindow) * 100;
                const right = Math.min(1, (s.end - viewStart) / timeWindow) * 100;
                const width = Math.max(0.5, right - left);
                return (
                  <div
                    key={s.uid}
                    className="absolute top-1 h-[20px] rounded-sm cursor-grab active:cursor-grabbing"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      backgroundColor: k.color,
                      opacity: isHover ? 0.9 : 0.65,
                    }}
                    title={`${k.label}: ${(s.end - s.start).toFixed(0)}ms`}
                    onPointerEnter={() => setHover(s)}
                    onPointerLeave={() => setHover(null)}
                    onPointerDown={(e) => {
                      const x = e.nativeEvent.offsetX;
                      const w = (e.currentTarget as HTMLElement).offsetWidth;
                      const mode: DragState["mode"] = x < 6 ? "left" : x > w - 6 ? "right" : "move";
                      startDrag(e, s, mode);
                    }}
                    onContextMenu={(e) => deleteSegment(e, s)}
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-[6px] cursor-ew-resize" />
                    <div className="absolute right-0 top-0 bottom-0 w-[6px] cursor-ew-resize" />
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
