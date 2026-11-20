import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ClientSettings,
  type ServerSettings,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ACCOUNT_SYNC_LOCAL_STATE_KEY,
  CLERK_ACCOUNT_SYNC_METADATA_KEY,
  DEFAULT_ACCOUNT_SYNC_LOCAL_STATE,
  MAX_CLERK_UNSAFE_METADATA_BYTES,
  SYNCABLE_CLIENT_SETTING_KEYS,
  SYNCABLE_SERVER_SETTING_KEYS,
  buildAccountSyncPayload,
  buildClientSettingsRestorePatch,
  buildServerSettingsRestorePatch,
  computeSyncContentHash,
  decodeAccountSyncPayload,
  getAccountSyncState,
  pickSyncableClientSettings,
  pickSyncableServerSettings,
  readAccountSyncLocalState,
  readAccountSyncPayloadFromMetadata,
  registerAccountSyncActions,
  requestAccountSyncRestore,
  requestAccountSyncSave,
  sanitizeSyncedThemePreferences,
  serializeAccountSyncMetadataValue,
  setAccountSyncState,
  updateAccountAutoSyncEnabled,
  writeAccountSyncLocalState,
} from "./accountCustomizationSync";

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("accountCustomizationSync", () => {
  afterEach(() => {
    registerAccountSyncActions(null);
    setAccountSyncState({
      status: "idle",
      autoSyncEnabled: true,
      lastSyncedUserId: null,
      lastSyncedCloudUpdatedAt: null,
      lastSyncedContentHash: null,
      lastError: null,
      cloudUpdatedAt: null,
      cloudDeviceLabel: null,
      hasCloudBackup: false,
      pendingConflict: false,
    });
  });

  describe("allowlists & diff-from-defaults", () => {
    it("excludes device-local, secret, path, theme-default, and security keys from allowlists", () => {
      const clientKeySet = new Set<string>(SYNCABLE_CLIENT_SETTING_KEYS);
      for (const excluded of [
        "voiceMicrophone",
        "voiceMicrophones",
        "snapShotEnabled",
        "snapShotIncludeAccessibility",
        "snapShotShortcut",
        "snapShotPlaySound",
        "snapShotSound",
        "snapShotFlash",
        "snapShotAnimations",
        "onboardingCompletedAt",
        "loadBalancingEnabled",
        "loadBalancingWeights",
        "pullRequestMergeMethodOverrides",
        "sidebarProjectGroupingOverrides",
      ]) {
        expect(clientKeySet.has(excluded)).toBe(false);
      }

      const serverKeySet = new Set<string>(SYNCABLE_SERVER_SETTING_KEYS);
      for (const excluded of [
        "defaultTheme",
        "defaultThemeSetAt",
        "defaultAppearance",
        "defaultAppearanceSetAt",
        "defaultRuntimeMode",
        "cloudSpeechCredentials",
        "secretProviders",
        "sourceControlHosts",
        "worktreesDirectory",
        "previousWorktreesDirectories",
        "obsidianVaultPath",
        "addProjectBaseDirectory",
        "providerInstances",
        "pythonReplMode",
        "toolSafetyGuardEnabled",
        "loopCircuitBreakerEnabled",
        "enableAgentBrowserAccess",
        "enableAgentDeviceAccess",
        "enableDeviceSupport",
        "enablePreviewTunnel",
        "requireConnectDeviceApproval",
        "guestSharingEnabled",
        "linkedEnvironmentsEnabled",
        "defaultProjectScripts",
        "observability",
        "environmentIcon",
      ]) {
        expect(serverKeySet.has(excluded)).toBe(false);
      }
    });

    it("pickSyncableClientSettings emits only allowlisted keys that differ from defaults", () => {
      const modified: ClientSettings = {
        ...DEFAULT_CLIENT_SETTINGS,
        chatWidth: "wide",
        fontSizeCode: 16,
        wordWrap: false,
        // Excluded keys modified locally:
        voiceMicrophone: "Built-in Mic",
        voiceMicrophones: [{ kind: "device", deviceId: "mic-1", label: "USB Mic" }],
        snapShotEnabled: true,
        snapShotShortcut: { kind: "modifier-pair", modifier: "alt" },
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        loadBalancingEnabled: true,
        pullRequestMergeMethodOverrides: { "owner/repo": "squash" },
        sidebarProjectGroupingOverrides: { "proj-1": "separate" },
      };

      expect(pickSyncableClientSettings(modified)).toEqual({
        chatWidth: "wide",
        fontSizeCode: 16,
        wordWrap: false,
      });
      expect(pickSyncableClientSettings(DEFAULT_CLIENT_SETTINGS)).toEqual({});
    });

    it("pickSyncableServerSettings emits only allowlisted keys that differ from defaults", () => {
      const modified: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        rsiAutoDistillEnabled: false,
        defaultThreadEnvMode: "worktree",
        branchNamingMode: "semantic",
        // Excluded security/path/secret/theme keys modified:
        worktreesDirectory: "/Users/alice/worktrees",
        pythonReplMode: true,
        toolSafetyGuardEnabled: false,
        loopCircuitBreakerEnabled: false,
        enableAgentBrowserAccess: false,
        enablePreviewTunnel: false,
        requireConnectDeviceApproval: true,
        guestSharingEnabled: true,
        linkedEnvironmentsEnabled: true,
        defaultTheme: "nord",
        defaultRuntimeMode: "full-access",
        cloudSpeechCredentials: {
          openai: "sk-secret-openai",
          xai: "xai-secret",
          openrouter: "or-secret",
        },
      };

      expect(pickSyncableServerSettings(modified)).toEqual({
        rsiAutoDistillEnabled: false,
        defaultThreadEnvMode: "worktree",
        branchNamingMode: "semantic",
      });
      expect(pickSyncableServerSettings(DEFAULT_SERVER_SETTINGS)).toEqual({});
    });
  });

  describe("sanitizeSyncedThemePreferences", () => {
    it("keeps valid fields and strips unknown keys, invalid appearanceMode, and raw CSS", () => {
      const sanitized = sanitizeSyncedThemePreferences({
        themeId: "  tokyo-night  ",
        appearanceMode: "dark",
        themeHalves: {
          light: "catppuccin-latte",
          dark: "  ",
          extra: "ignored",
        },
        typographyAdvanced: true,
        css: "body { background: red; }",
        colors: { primary: "#000" },
        unknownField: "nope",
      });

      expect(sanitized).toEqual({
        themeId: "tokyo-night",
        appearanceMode: "dark",
        themeHalves: {
          light: "catppuccin-latte",
        },
        typographyAdvanced: true,
      });

      expect(
        sanitizeSyncedThemePreferences({
          themeId: "custom { color: red; }",
          appearanceMode: "neon",
          themeHalves: {
            light: "a\nb",
            dark: "{bad}",
          },
          typographyAdvanced: "yes",
        }),
      ).toEqual({});
    });
  });

  describe("buildAccountSyncPayload", () => {
    it("preserves existingCloudServerSettings when serverSettings is null", () => {
      const payload = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          chatWidth: "full",
        },
        theme: {
          themeId: "nord",
          appearanceMode: "dark",
        },
        serverSettings: null,
        existingCloudServerSettings: {
          rsiAutoDistillEnabled: false,
          defaultThreadEnvMode: "worktree",
          // Excluded/invalid entries should be stripped even from existing cloud cache:
          ...({
            worktreesDirectory: "/tmp/secret",
            pythonReplMode: true,
            verificationGateMode: "invalid-mode",
          } as unknown as Partial<ServerSettings>),
        },
        deviceLabel: "  MacBook Pro  ",
        now: "2026-11-19T21:30:00.000Z",
      });

      expect(payload).toEqual({
        version: 1,
        updatedAt: "2026-11-19T21:30:00.000Z",
        deviceLabel: "MacBook Pro",
        clientSettings: {
          chatWidth: "full",
        },
        theme: {
          themeId: "nord",
          appearanceMode: "dark",
        },
        serverSettings: {
          rsiAutoDistillEnabled: false,
          defaultThreadEnvMode: "worktree",
        },
      });
    });

    it("omits empty sections when everything matches defaults", () => {
      const payload = buildAccountSyncPayload({
        clientSettings: DEFAULT_CLIENT_SETTINGS,
        theme: {},
        serverSettings: DEFAULT_SERVER_SETTINGS,
        now: new Date("2026-11-19T21:30:00.000Z"),
      });

      expect(payload).toEqual({
        version: 1,
        updatedAt: "2026-11-19T21:30:00.000Z",
      });
      expect("clientSettings" in payload).toBe(false);
      expect("theme" in payload).toBe(false);
      expect("serverSettings" in payload).toBe(false);
    });
  });

  describe("decodeAccountSyncPayload & readAccountSyncPayloadFromMetadata", () => {
    it("strips unknown/excluded keys and drops individual invalid values while keeping valid siblings", () => {
      const decoded = decodeAccountSyncPayload(
        JSON.stringify({
          version: 1,
          updatedAt: "2026-11-19T21:30:00.000Z",
          deviceLabel: "Workstation",
          clientSettings: {
            chatWidth: "wide",
            fontSizeCode: 16,
            diffLayout: "not-a-layout",
            glassOpacity: 999,
            voiceMicrophones: [{ id: "m1", label: "Mic", priority: 0 }],
            snapShotShortcut: { kind: "both-shift-keys" },
            unknownClientKey: true,
          },
          theme: {
            themeId: "nord",
            appearanceMode: "system",
            css: "* { display: none; }",
          },
          serverSettings: {
            rsiAutoDistillEnabled: false,
            defaultThreadEnvMode: "bogus-env",
            branchNamingMode: "semantic",
            verificationGateMode: "invalid-gate",
            worktreesDirectory: "/Users/evil",
            pythonReplMode: true,
            toolSafetyGuardEnabled: false,
          },
        }),
      );

      expect(decoded).toEqual({
        version: 1,
        updatedAt: "2026-11-19T21:30:00.000Z",
        deviceLabel: "Workstation",
        clientSettings: {
          chatWidth: "wide",
          fontSizeCode: 16,
        },
        theme: {
          themeId: "nord",
          appearanceMode: "system",
        },
        serverSettings: {
          rsiAutoDistillEnabled: false,
          branchNamingMode: "semantic",
        },
      });
    });

    it("rejects wrong version, invalid updatedAt, and malformed payloads", () => {
      expect(
        decodeAccountSyncPayload({ version: 2, updatedAt: "2026-11-19T21:30:00.000Z" }),
      ).toBeNull();
      expect(decodeAccountSyncPayload({ version: 1, updatedAt: "not-a-date" })).toBeNull();
      expect(decodeAccountSyncPayload({ version: 1, updatedAt: "" })).toBeNull();
      expect(decodeAccountSyncPayload("{not json")).toBeNull();
      expect(decodeAccountSyncPayload(null)).toBeNull();
    });

    it("reads payload from Clerk unsafeMetadata record", () => {
      const payload = buildAccountSyncPayload({
        clientSettings: { ...DEFAULT_CLIENT_SETTINGS, wordWrap: false },
        now: "2026-11-19T21:30:00.000Z",
      });
      const extracted = readAccountSyncPayloadFromMetadata({
        [CLERK_ACCOUNT_SYNC_METADATA_KEY]: JSON.stringify(payload),
      });
      expect(extracted).toEqual(payload);
      expect(readAccountSyncPayloadFromMetadata({})).toBeNull();
    });
  });

  describe("computeSyncContentHash", () => {
    it("produces identical hashes regardless of key order, version, updatedAt, or deviceLabel", () => {
      const hashA = computeSyncContentHash({
        version: 1,
        updatedAt: "2026-11-19T21:00:00.000Z",
        deviceLabel: "Laptop A",
        clientSettings: {
          wordWrap: false,
          chatWidth: "wide",
          threadDetailsItems: { b: false, a: true },
        },
        theme: {
          appearanceMode: "dark",
          themeId: "nord",
          themeHalves: { dark: "nord", light: "latte" },
        },
        serverSettings: {
          branchNamingMode: "semantic",
          rsiAutoDistillEnabled: false,
        },
      });

      const hashB = computeSyncContentHash({
        serverSettings: {
          rsiAutoDistillEnabled: false,
          branchNamingMode: "semantic",
        },
        theme: {
          themeHalves: { light: "latte", dark: "nord" },
          themeId: "nord",
          appearanceMode: "dark",
        },
        clientSettings: {
          threadDetailsItems: { a: true, b: false },
          chatWidth: "wide",
          wordWrap: false,
        },
      });

      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[0-9a-f]{16}$/);

      const hashDifferent = computeSyncContentHash({
        clientSettings: {
          wordWrap: true,
          chatWidth: "wide",
          threadDetailsItems: { a: true, b: false },
        },
      });
      expect(hashDifferent).not.toBe(hashA);
    });
  });

  describe("serializeAccountSyncMetadataValue", () => {
    it("measures combined unsafeMetadata UTF-8 bytes and trims providerModelPreferences then favorites", () => {
      const smallPayload = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          chatWidth: "wide",
        },
        now: "2026-11-19T21:30:00.000Z",
      });
      const smallResult = serializeAccountSyncMetadataValue(smallPayload, { existingKey: "hello" });
      expect(smallResult.ok).toBe(true);
      if (smallResult.ok) {
        expect(smallResult.trimmed).toBe(false);
        expect(smallResult.totalMetadataBytes).toBeLessThanOrEqual(MAX_CLERK_UNSAFE_METADATA_BYTES);
      }

      // Build a payload whose providerModelPreferences alone pushes totalMetadataBytes over 6000.
      const largePrefs: Record<
        string,
        { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
      > = {};
      for (let index = 0; index < 45; index += 1) {
        largePrefs[ProviderInstanceId.make(`provider-${index}`)] = {
          hiddenModels: [`hidden-model-slug-${index}-padding-for-size`],
          modelOrder: [`ordered-model-slug-${index}-padding-for-size-🚀`],
        };
      }

      const trimFirstPayload = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          chatWidth: "wide",
          providerModelPreferences: largePrefs as ClientSettings["providerModelPreferences"],
          favorites: [
            {
              provider: ProviderInstanceId.make("codex"),
              model: "gpt-5",
            },
          ],
        },
        now: "2026-11-19T21:30:00.000Z",
      });

      const trimmedOnce = serializeAccountSyncMetadataValue(trimFirstPayload);
      expect(trimmedOnce.ok).toBe(true);
      if (trimmedOnce.ok) {
        expect(trimmedOnce.trimmed).toBe(true);
        expect(trimmedOnce.trimmedKeys).toEqual(["providerModelPreferences"]);
        expect(trimmedOnce.payload.clientSettings?.providerModelPreferences).toBeUndefined();
        expect(trimmedOnce.payload.clientSettings?.favorites).toHaveLength(1);
        expect(trimmedOnce.payload.clientSettings?.chatWidth).toBe("wide");
        expect(trimmedOnce.totalMetadataBytes).toBeLessThanOrEqual(MAX_CLERK_UNSAFE_METADATA_BYTES);
      }

      // Now make favorites also large so both providerModelPreferences and favorites must be trimmed.
      const manyFavorites = Array.from({ length: 80 }, (_, index) => ({
        provider: ProviderInstanceId.make("codex"),
        model: `favorite-model-${index}-with-long-identifier-string`,
      }));
      const trimBothPayload = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          chatWidth: "wide",
          providerModelPreferences: largePrefs as ClientSettings["providerModelPreferences"],
          favorites: manyFavorites,
        },
        now: "2026-11-19T21:30:00.000Z",
      });
      const trimmedTwice = serializeAccountSyncMetadataValue(trimBothPayload);
      expect(trimmedTwice.ok).toBe(true);
      if (trimmedTwice.ok) {
        expect(trimmedTwice.trimmed).toBe(true);
        expect(trimmedTwice.trimmedKeys).toEqual(["providerModelPreferences", "favorites"]);
        expect(trimmedTwice.payload.clientSettings).toEqual({ chatWidth: "wide" });
      }
    });

    it("returns payload-too-large when remaining metadata still exceeds 6000 UTF-8 bytes", () => {
      const payload = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          speechCustomWords: Array.from({ length: 60 }, (_, index) => ({
            term: `term-${index}-東京`,
            aliases: [`alias-${index}-a`, `alias-${index}-b`],
          })),
        },
        now: "2026-11-19T21:30:00.000Z",
      });

      const result = serializeAccountSyncMetadataValue(payload, {
        otherMetadata: "x".repeat(4_500),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("payload-too-large");
        expect(result.totalMetadataBytes).toBeGreaterThan(MAX_CLERK_UNSAFE_METADATA_BYTES);
        expect(result.bytes).toBeGreaterThan(0);
      }
    });
  });

  describe("restore patches", () => {
    it("buildClientSettingsRestorePatch restores cloud values, resets omitted allowlisted keys to defaults, and leaves excluded keys untouched", () => {
      const patch = buildClientSettingsRestorePatch({
        chatWidth: "full",
        fontSizeCode: 17,
        // Excluded key must never appear in restore patch:
        voiceMicrophones: [{ kind: "device", deviceId: "evil", label: "Evil" }],
      } as Partial<ClientSettings>);

      expect(patch.chatWidth).toBe("full");
      expect(patch.fontSizeCode).toBe(17);
      // Previously changed setting on Device B omitted in cloud payload resets back to default:
      expect(patch.wordWrap).toBe(DEFAULT_CLIENT_SETTINGS.wordWrap);
      expect(patch.fontSizeInterface).toBe(DEFAULT_CLIENT_SETTINGS.fontSizeInterface);
      expect("voiceMicrophones" in patch).toBe(false);
      expect("snapShotShortcut" in patch).toBe(false);
      expect("onboardingCompletedAt" in patch).toBe(false);
    });

    it("buildServerSettingsRestorePatch returns minimal changed patch and resets omitted allowlisted keys", () => {
      const currentServer: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        rsiAutoDistillEnabled: false,
        defaultThreadEnvMode: "worktree",
        branchNamingMode: "semantic",
        // Excluded fields currently customized locally:
        worktreesDirectory: "/local/worktrees",
        pythonReplMode: true,
        toolSafetyGuardEnabled: false,
      };

      const patch = buildServerSettingsRestorePatch(
        {
          rsiAutoDistillEnabled: false,
          branchNamingMode: "custom",
          promptSuggestionsEnabled: true,
          // Excluded keys in untrusted payload must be ignored:
          ...({
            worktreesDirectory: "/remote/override",
            pythonReplMode: false,
          } as unknown as Partial<ServerSettings>),
        },
        currentServer,
      );

      expect(patch).toEqual({
        // rsiAutoDistillEnabled is already false on currentServer -> omitted!
        // defaultThreadEnvMode is omitted from cloud -> resets back to default null!
        defaultThreadEnvMode: null,
        branchNamingMode: "custom",
        promptSuggestionsEnabled: true,
      });

      // When current server already matches cloud + defaults, returns {}.
      const alreadySyncedServer: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        rsiAutoDistillEnabled: false,
        branchNamingMode: "custom",
        promptSuggestionsEnabled: true,
      };
      expect(
        buildServerSettingsRestorePatch(
          {
            rsiAutoDistillEnabled: false,
            branchNamingMode: "custom",
            promptSuggestionsEnabled: true,
          },
          alreadySyncedServer,
        ),
      ).toEqual({});
    });
  });

  describe("local state persistence & reactive store", () => {
    it("reads defaults safely from missing or corrupt storage and persists updates", () => {
      expect(readAccountSyncLocalState(null)).toEqual(DEFAULT_ACCOUNT_SYNC_LOCAL_STATE);

      const corruptStorage = createMemoryStorage({
        [ACCOUNT_SYNC_LOCAL_STATE_KEY]: "{broken-json",
      });
      expect(readAccountSyncLocalState(corruptStorage)).toEqual(DEFAULT_ACCOUNT_SYNC_LOCAL_STATE);

      const storage = createMemoryStorage();
      const nextState = {
        autoSyncEnabled: false,
        lastSyncedUserId: "user_123",
        lastSyncedCloudUpdatedAt: "2026-11-19T21:30:00.000Z",
        lastSyncedContentHash: "0123456789abcdef",
      };
      expect(writeAccountSyncLocalState(nextState, storage)).toBe(true);
      expect(readAccountSyncLocalState(storage)).toEqual(nextState);
    });

    it("manages runtime state and registered coordinator actions", async () => {
      const saveNow = vi.fn(async () => {});
      const restoreNow = vi.fn(async () => {});
      const setAutoSyncEnabled = vi.fn(async () => {});

      const unregister = registerAccountSyncActions({
        saveNow,
        restoreNow,
        setAutoSyncEnabled,
      });

      setAccountSyncState({ status: "synced", hasCloudBackup: true });
      expect(getAccountSyncState().status).toBe("synced");
      expect(getAccountSyncState().hasCloudBackup).toBe(true);

      await requestAccountSyncSave();
      await requestAccountSyncRestore();
      await updateAccountAutoSyncEnabled(false);

      expect(saveNow).toHaveBeenCalledTimes(1);
      expect(restoreNow).toHaveBeenCalledTimes(1);
      expect(setAutoSyncEnabled).toHaveBeenCalledWith(false);
      expect(getAccountSyncState().autoSyncEnabled).toBe(false);

      unregister();
      await requestAccountSyncSave();
      expect(saveNow).toHaveBeenCalledTimes(1);
    });

    it("produces identical hashes across encode/decode round trips with non-default fields", () => {
      const built = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          glassOpacity: 62,
          chatWidth: "wide",
          wordWrap: false,
          favorites: [
            { provider: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
          ],
          providerModelPreferences: {
            [ProviderInstanceId.make("claudeAgent")]: {
              hiddenModels: ["claude-haiku-5-5"],
              modelOrder: ["claude-opus-5-5"],
            },
          },
          speechCustomWords: [{ term: "T3Code", aliases: ["T3"] }],
        },
        theme: {
          themeId: "liquid-glass",
          appearanceMode: "dark",
          themeHalves: { light: "t3-chat", dark: "liquid-glass" },
          typographyAdvanced: true,
        },
        serverSettings: {
          ...DEFAULT_SERVER_SETTINGS,
          rsiAutoDistillEnabled: false,
          outputShaperEnabled: false,
          defaultThreadEnvMode: "worktree",
          snoozePresets: [{ kind: "after", minutes: 30 }],
          sourceControlWritingStyle: {
            mode: "conventional_commits",
            customInstructions: "Keep subjects concise.",
            followChangeRequestTemplates: false,
          },
        },
        now: "2026-11-19T22:00:00.000Z",
      });

      const serialized = serializeAccountSyncMetadataValue(built, {});
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) throw new Error("expected serialized payload");

      const decoded = readAccountSyncPayloadFromMetadata({
        [CLERK_ACCOUNT_SYNC_METADATA_KEY]: serialized.json,
      });
      expect(decoded).not.toBeNull();
      if (!decoded) throw new Error("expected decoded payload");

      expect(computeSyncContentHash(built)).toBe(computeSyncContentHash(decoded));
    });

    it("records trimmedClientKeys and skips resetting trimmed keys on restore", () => {
      const largePreferences: NonNullable<ClientSettings["providerModelPreferences"]> =
        Object.fromEntries(
          Array.from({ length: 45 }, (_, index) => [
            ProviderInstanceId.make(`provider-${index}`),
            {
              hiddenModels: [`hidden-${index}-${"x".repeat(90)}`],
              modelOrder: [`model-${index}`],
            },
          ]),
        );
      const built = buildAccountSyncPayload({
        clientSettings: {
          ...DEFAULT_CLIENT_SETTINGS,
          glassOpacity: 74,
          providerModelPreferences: largePreferences,
          favorites: [
            { provider: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
          ],
        },
        now: "2026-11-19T22:00:00.000Z",
      });

      const serialized = serializeAccountSyncMetadataValue(built, {});
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) throw new Error("expected trimmed payload");
      expect(serialized.trimmed).toBe(true);
      expect(serialized.trimmedKeys).toContain("providerModelPreferences");

      const decoded = decodeAccountSyncPayload(serialized.json);
      expect(decoded?.trimmedClientKeys).toContain("providerModelPreferences");

      const patch = buildClientSettingsRestorePatch(
        decoded?.clientSettings,
        decoded?.trimmedClientKeys,
      );
      expect(patch.glassOpacity).toBe(74);
      expect("providerModelPreferences" in patch).toBe(false);
    });
  });
});
