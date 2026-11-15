import { useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";

type AsciiMode = "vortex" | "waves" | "matrix";

interface ContentVisibilityAutoStateChangeEvent extends Event {
  readonly skipped?: boolean;
}

const GLYPH_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

function getInitialReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LiquidGlassAsciiBackdrop() {
  const [mode, setMode] = useState<AsciiMode>("vortex");
  const [userPaused, setUserPaused] = useState<boolean>(getInitialReducedMotion);
  const modeRef = useRef<AsciiMode>("vortex");
  const userPausedRef = useRef<boolean>(false);
  const drawStaticRef = useRef<(() => void) | null>(null);
  const syncLoopRef = useRef<(() => void) | null>(null);

  const bindStageRef = useStableCallback((stageNode: HTMLDivElement | null) => {
    if (!stageNode || typeof window === "undefined") {
      return;
    }
    const canvas = stageNode.querySelector("canvas");
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      return;
    }

    userPausedRef.current = getInitialReducedMotion();

    const cellW = 14;
    const cellH = 20;
    let cols = 0;
    let rows = 0;
    let rafId = 0;
    let timeSeconds = 0;
    let lastTime = performance.now();
    let contentSkipped = false;
    let pointerX = -1000;
    let pointerY = -1000;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / cellW) + 1;
      rows = Math.ceil(height / cellH) + 1;
      ctx.font = '500 12px "SF Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
      ctx.textBaseline = "top";
    };

    const drawFrame = (now: number, forceStatic = false) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      if (!forceStatic) {
        timeSeconds += dt;
      }

      const width = window.innerWidth;
      const height = window.innerHeight;
      const isDark = document.documentElement.classList.contains("dark");
      ctx.clearRect(0, 0, width, height);

      const cx = cols * 0.52;
      const cy = rows * 0.48;
      const mx = pointerX / cellW;
      const my = pointerY / cellH;
      const activeMode = modeRef.current;

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const dx = x - cx;
          const dy = (y - cy) * 1.3;
          const dist = Math.hypot(dx, dy);

          const mdx = x - mx;
          const mdy = (y - my) * 1.3;
          const mdist = Math.hypot(mdx, mdy);
          const mouseRipple =
            mdist < 16 ? Math.sin(mdist * 0.85 - timeSeconds * 6) * (1 - mdist / 16) * 0.55 : 0;

          let v = 0;
          if (activeMode === "vortex") {
            const angle = Math.atan2(dy, dx);
            const swirl = Math.sin(dist * 0.22 - timeSeconds * 1.85 + angle * 3.0);
            const harmonic =
              Math.cos(x * 0.11 + timeSeconds * 0.75) * Math.sin(y * 0.13 - timeSeconds * 0.6);
            const radialDecay = Math.max(0, 1 - dist / (Math.max(cols, rows) * 0.78));
            v = (swirl * 0.55 + harmonic * 0.45) * radialDecay + mouseRipple;
          } else if (activeMode === "waves") {
            const w1 = Math.sin(
              x * 0.09 + timeSeconds * 1.35 + Math.cos(y * 0.08 + timeSeconds * 0.7),
            );
            const w2 = Math.cos(
              y * 0.12 - timeSeconds * 1.05 + Math.sin(x * 0.07 - timeSeconds * 0.8),
            );
            const w3 = Math.sin(dist * 0.14 - timeSeconds * 1.5) * 0.35;
            v = w1 * 0.42 + w2 * 0.38 + w3 + mouseRipple;
          } else {
            const colSeed = Math.sin(x * 12.9898) * 43758.5453;
            const speed = 1.4 + (colSeed - Math.floor(colSeed)) * 2.1;
            const stream = Math.sin(y * 0.22 - timeSeconds * speed * 2.4 + colSeed);
            const pulse = Math.cos(x * 0.27 + timeSeconds * 0.85);
            v = stream * 0.72 + pulse * 0.28 + mouseRipple;
          }

          const norm = Math.max(0, Math.min(0.999, (v + 1.15) / 2.3));
          if (norm < 0.22) {
            continue;
          }

          const idx = Math.floor(norm * GLYPH_RAMP.length);
          const ch = GLYPH_RAMP[idx] ?? ".";
          if (ch === " ") {
            continue;
          }

          const alpha = isDark ? (norm - 0.2) * 0.42 : (norm - 0.2) * 0.28;
          if (norm > 0.78) {
            ctx.fillStyle = isDark
              ? `rgba(103, 232, 249, ${(alpha * 1.35).toFixed(3)})`
              : `rgba(14, 116, 144, ${(alpha * 1.25).toFixed(3)})`;
          } else if (norm > 0.56) {
            ctx.fillStyle = isDark
              ? `rgba(192, 132, 252, ${(alpha * 1.15).toFixed(3)})`
              : `rgba(109, 40, 217, ${(alpha * 1.1).toFixed(3)})`;
          } else {
            ctx.fillStyle = isDark
              ? `rgba(148, 163, 184, ${(alpha * 0.85).toFixed(3)})`
              : `rgba(71, 85, 105, ${(alpha * 0.75).toFixed(3)})`;
          }

          ctx.fillText(ch, x * cellW, y * cellH);
        }
      }
    };

    const shouldRun = () => !userPausedRef.current && !document.hidden && !contentSkipped;

    const tick = (now: number) => {
      if (!shouldRun()) {
        rafId = 0;
        return;
      }
      drawFrame(now, false);
      rafId = window.requestAnimationFrame(tick);
    };

    const syncLoop = () => {
      if (shouldRun()) {
        if (!rafId) {
          lastTime = performance.now();
          rafId = window.requestAnimationFrame(tick);
        }
      } else if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    drawStaticRef.current = () => {
      drawFrame(performance.now(), true);
    };
    syncLoopRef.current = syncLoop;

    const handlePointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
    };

    const handleVisibilityChange = () => {
      syncLoop();
    };

    const handleContentVisibility = (event: Event) => {
      const cvEvent = event as ContentVisibilityAutoStateChangeEvent;
      contentSkipped = Boolean(cvEvent.skipped);
      syncLoop();
    };

    let intersectionObserver: IntersectionObserver | null = null;
    if (
      !("contentVisibility" in document.documentElement.style) &&
      typeof IntersectionObserver === "function"
    ) {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          contentSkipped = !entry.isIntersecting;
        }
        syncLoop();
      });
      intersectionObserver.observe(stageNode);
    }

    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      userPausedRef.current = event.matches;
      setUserPaused(event.matches);
      if (event.matches) {
        drawFrame(performance.now(), true);
      }
      syncLoop();
    };

    resize();
    drawFrame(performance.now(), true);
    syncLoop();

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    stageNode.addEventListener("contentvisibilityautostatechange", handleContentVisibility);
    motionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      drawStaticRef.current = null;
      syncLoopRef.current = null;
      intersectionObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stageNode.removeEventListener("contentvisibilityautostatechange", handleContentVisibility);
      motionQuery?.removeEventListener("change", handleMotionPreferenceChange);
    };
  });

  const handleModeSelect = (nextMode: AsciiMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
    drawStaticRef.current?.();
  };

  const handleTogglePause = () => {
    const nextPaused = !userPaused;
    userPausedRef.current = nextPaused;
    setUserPaused(nextPaused);
    if (nextPaused) {
      drawStaticRef.current?.();
    }
    syncLoopRef.current?.();
  };

  return (
    <>
      <div
        ref={bindStageRef}
        aria-hidden="true"
        data-liquid-glass-ascii-backdrop=""
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
        style={{ contentVisibility: "auto" }}
      >
        <div className="liquid-glass-ambient-glow" />
        <canvas className="block h-full w-full opacity-90" />
        <div className="liquid-glass-specular-sheen" />
      </div>
      <div
        role="region"
        aria-label="Liquid Glass ASCII background controls"
        className="liquid-glass-hud-pill fixed right-3 bottom-3 z-30 flex items-center gap-1 rounded-full px-2 py-1 text-3xs font-medium select-none"
      >
        <span className="px-1.5 font-mono tracking-wider text-muted-foreground uppercase">
          ASCII
        </span>
        {(["vortex", "waves", "matrix"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => handleModeSelect(item)}
            data-active={mode === item ? "true" : "false"}
            className="liquid-glass-hud-btn rounded-full px-2 py-0.5 capitalize transition-colors"
          >
            {item}
          </button>
        ))}
        <button
          type="button"
          onClick={handleTogglePause}
          className="liquid-glass-hud-btn rounded-full px-2 py-0.5 font-mono transition-colors"
        >
          {userPaused ? "Play ASCII" : "Pause ASCII"}
        </button>
      </div>
    </>
  );
}
