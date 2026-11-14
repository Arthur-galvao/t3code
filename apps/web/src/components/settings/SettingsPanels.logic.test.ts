import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { searchSettings } from "./settingsSearch";
import {
  backgroundActivitySharedPolicySettings,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("workflow safeguards & RSI settings search", () => {
  it("defaults autoVerifyEnabled and Obsidian second-brain settings", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.autoVerifyEnabled).toBe(true);
    expect(DEFAULT_UNIFIED_SETTINGS.obsidianMemorySyncEnabled).toBe(true);
    expect(DEFAULT_UNIFIED_SETTINGS.obsidianVaultPath).toBe("");
  });

  it("indexes auto-verify, Obsidian second-brain, and RSI & CCR observability in settings search", () => {
    const autoVerifyMatches = searchSettings("Auto-verify code edits");
    expect(autoVerifyMatches[0]?.id).toBe("auto-verify");
    expect(autoVerifyMatches[0]?.to).toBe("/settings/threads");
    expect(autoVerifyMatches[0]?.targetId).toBe("auto-verify");

    const obsidianMatches = searchSettings("Obsidian second-brain");
    expect(obsidianMatches[0]?.id).toBe("obsidian-memory");
    expect(obsidianMatches[0]?.to).toBe("/settings/threads");
    expect(obsidianMatches[0]?.targetId).toBe("obsidian-memory");

    const rsiMatches = searchSettings("RSI & CCR");
    expect(rsiMatches[0]?.id).toBe("rsi-ccr-observability");
    expect(rsiMatches[0]?.to).toBe("/settings/diagnostics");
    expect(rsiMatches[0]?.targetId).toBe("rsi-ccr-observability");
  });
});
