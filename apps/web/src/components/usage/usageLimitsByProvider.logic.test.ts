import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { limitWindowsByDriver, mostUsedWindow } from "./usageLimitsByProvider.logic";

const window = (id: string, usedPercent: number) =>
  ({ id, kind: "session", label: id, usedPercent }) as ServerProviderUsageWindow;

describe("usageLimitsByProvider", () => {
  it("groups pooled windows by driver using the pooled used percent", () => {
    const grouped = limitWindowsByDriver([
      {
        driver: "codex" as never,
        windows: [
          { usedPercent: 40, members: [{ window: window("5h", 10) }] },
          { usedPercent: 0, members: [] },
        ],
      },
    ]);
    expect(grouped.get("codex" as never)).toEqual([window("5h", 40)]);
  });

  it("picks the most used window", () => {
    expect(mostUsedWindow([window("a", 10), window("b", 70), window("c", 30)])?.id).toBe("b");
    expect(mostUsedWindow([])).toBeNull();
  });
});
