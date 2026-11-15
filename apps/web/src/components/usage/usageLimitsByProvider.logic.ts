import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

type Driver = ServerProvider["driver"];

interface PoolLike {
  readonly driver: Driver;
  readonly windows: ReadonlyArray<{
    readonly usedPercent: number;
    readonly members: ReadonlyArray<{ readonly window: ServerProviderUsageWindow }>;
  }>;
}

/** One entry per driver: its pooled windows as plain windows, so existing limit bars can draw them. */
export function limitWindowsByDriver(
  pools: readonly PoolLike[],
): ReadonlyMap<Driver, readonly ServerProviderUsageWindow[]> {
  return new Map(
    pools.map((pool) => [
      pool.driver,
      pool.windows.flatMap((entry) => {
        const first = entry.members[0]?.window;
        return first ? [{ ...first, usedPercent: entry.usedPercent }] : [];
      }),
    ]),
  );
}

export function mostUsedWindow(
  windows: readonly ServerProviderUsageWindow[],
): ServerProviderUsageWindow | null {
  return windows.reduce<ServerProviderUsageWindow | null>(
    (top, window) => (top === null || window.usedPercent > top.usedPercent ? window : top),
    null,
  );
}
