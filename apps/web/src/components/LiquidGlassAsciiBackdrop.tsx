import { useSyncExternalStore } from "react";

import { useStableCallback } from "../hooks/useStableCallback";

// Matches the published environment theme file ~/.t3/userdata/themes/liquid-glass.json.
const LIQUID_GLASS_THEME_ID = "liquid-glass";
const GLYPH_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const CELL_W = 14;
const CELL_H = 20;
// Full-window canvas redraws are costly; 30fps keeps the swirl smooth at half the GPU work.
const FRAME_MS = 1000 / 30;

function subscribeThemeId(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme-id"] });
  return () => observer.disconnect();
}

function isLiquidGlassThemeActive() {
  return document.documentElement.dataset.themeId === LIQUID_GLASS_THEME_ID;
}

export function LiquidGlassAsciiBackdrop() {
  const active = useSyncExternalStore(subscribeThemeId, isLiquidGlassThemeActive, () => false);
  return active ? <LiquidGlassAsciiStage /> : null;
}

function LiquidGlassAsciiStage() {
  const bindStageRef = useStableCallback((stageNode: HTMLDivElement | null) => {
    const canvas = stageNode?.querySelector("canvas");
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!stageNode || !canvas || !ctx) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let cols = 0;
    let rows = 0;
    let rafId = 0;
    let timeSeconds = 0;
    let lastTime = performance.now();
    let pointerX = -1000;
    let pointerY = -1000;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
      canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(window.innerWidth / CELL_W) + 1;
      rows = Math.ceil(window.innerHeight / CELL_H) + 1;
      ctx.font = '500 12px "SF Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
      ctx.textBaseline = "top";
      draw();
    };

    const draw = () => {
      const isDark = document.documentElement.classList.contains("dark");
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const cx = cols * 0.62;
      const cy = rows * 0.46;
      const mx = pointerX / CELL_W;
      const my = pointerY / CELL_H;
      const t = timeSeconds;

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const dx = x - cx;
          const dy = (y - cy) * 1.3;
          const dist = Math.hypot(dx, dy);
          const mdist = Math.hypot(x - mx, (y - my) * 1.3);
          const ripple = mdist < 14 ? Math.sin(mdist * 0.85 - t * 5) * (1 - mdist / 14) * 0.5 : 0;
          const swirl = Math.sin(dist * 0.2 - t * 1.2 + Math.atan2(dy, dx) * 3);
          const drift = Math.cos(x * 0.09 + t * 0.5) * Math.sin(y * 0.11 - t * 0.4);
          const decay = Math.max(0, 1 - dist / (Math.max(cols, rows) * 0.85));
          const norm = Math.min(0.999, ((swirl * 0.6 + drift * 0.4) * decay + ripple + 1.15) / 2.3);
          if (norm < 0.42) continue;

          const ch = GLYPH_RAMP[Math.floor(norm * GLYPH_RAMP.length)] ?? ".";
          const alpha = (norm - 0.4) * (isDark ? 0.5 : 0.32);
          ctx.fillStyle =
            norm > 0.74
              ? isDark
                ? `rgba(216, 180, 254, ${alpha.toFixed(3)})`
                : `rgba(126, 34, 206, ${alpha.toFixed(3)})`
              : isDark
                ? `rgba(168, 85, 247, ${(alpha * 0.8).toFixed(3)})`
                : `rgba(109, 40, 217, ${(alpha * 0.7).toFixed(3)})`;
          ctx.fillText(ch, x * CELL_W, y * CELL_H);
        }
      }
    };

    const shouldRun = () => !motionQuery.matches && !document.hidden;

    const tick = (now: number) => {
      rafId = shouldRun() ? window.requestAnimationFrame(tick) : 0;
      if (now - lastTime < FRAME_MS) return;
      timeSeconds += Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      draw();
    };

    const syncLoop = () => {
      if (shouldRun() && !rafId) {
        lastTime = performance.now();
        rafId = window.requestAnimationFrame(tick);
      } else if (!shouldRun() && rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
    };

    resize();
    syncLoop();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("visibilitychange", syncLoop);
    motionQuery.addEventListener("change", syncLoop);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("visibilitychange", syncLoop);
      motionQuery.removeEventListener("change", syncLoop);
    };
  });

  return (
    <div
      ref={bindStageRef}
      aria-hidden="true"
      data-liquid-glass-ascii-backdrop=""
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
    >
      <div data-liquid-glass-aurora="" className="absolute -inset-1/4" />
      <canvas className="absolute inset-0 block h-full w-full" />
      <div data-liquid-glass-sheen="" className="absolute inset-0" />
    </div>
  );
}
