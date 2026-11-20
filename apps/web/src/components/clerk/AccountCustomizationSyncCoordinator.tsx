import { useAuth, useUser } from "@clerk/react";
import {
  AuthSettingsWriteScope,
  ClientServerSettingsPatch,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useEffect, useRef } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import {
  buildAccountSyncPayload,
  buildClientSettingsRestorePatch,
  buildServerSettingsRestorePatch,
  CLERK_ACCOUNT_SYNC_METADATA_KEY,
  computeSyncContentHash,
  DEFAULT_ACCOUNT_SYNC_LOCAL_STATE,
  pickSyncableClientSettings,
  pickSyncableServerSettings,
  readAccountSyncLocalState,
  readAccountSyncPayloadFromMetadata,
  registerAccountSyncActions,
  sanitizeSyncedThemePreferences,
  serializeAccountSyncMetadataValue,
  setAccountSyncState,
  writeAccountSyncLocalState,
  type AccountCustomizationSyncPayload,
  type SyncedThemePreferences,
} from "../../cloud/accountCustomizationSync";
import { isElectron } from "../../env";
import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import {
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useTheme } from "../../hooks/useTheme";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { isKnownThemePreference } from "../../themePalette";
import { toastManager } from "../ui/toast";

const AUTO_PUSH_DEBOUNCE_MS = 3_000;
const IN_FLIGHT_FOLLOWUP_DELAY_MS = 500;
const decodeClientServerSettingsPatch = Schema.decodeUnknownOption(ClientServerSettingsPatch);

function resolveDeviceLabel(): string {
  const runtime = isElectron ? "Desktop" : "Web";
  if (typeof navigator === "undefined") return runtime;
  const userAgent = navigator.userAgent;
  if (/Windows/i.test(userAgent)) return `${runtime} (Windows)`;
  if (/Macintosh|Mac OS X/i.test(userAgent)) return `${runtime} (macOS)`;
  if (/Linux/i.test(userAgent)) return `${runtime} (Linux)`;
  return runtime;
}

export function AccountCustomizationSyncCoordinator() {
  const gt = useGT();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clientSettings = useClientSettings();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const theme = useTheme();
  const typographyAdvanced = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const canWritePrimarySettings = useEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope);
  const primaryConnected =
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null;
  const primaryServerSettings =
    primaryConnected && primaryEnvironment.serverConfig !== null
      ? primaryEnvironment.serverConfig.settings
      : null;
  const persistServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const activeUserIdRef = useRef<string | null>(null);
  const initialRestoreSettledRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const pushInFlightRef = useRef(false);
  const queuedPushAfterFlightRef = useRef(false);
  const serverRestoreBlockedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const scheduledPushHashRef = useRef<string | null>(null);
  const echoReleaseTimerRef = useRef<number | null>(null);
  const followupTimerRef = useRef<number | null>(null);
  const lastSyncedContentHashRef = useRef<string | null>(
    readAccountSyncLocalState().lastSyncedContentHash,
  );
  const lastSyncedCloudUpdatedAtRef = useRef<string | null>(
    readAccountSyncLocalState().lastSyncedCloudUpdatedAt,
  );
  const existingCloudServerSettingsRef = useRef<Partial<ServerSettings> | null>(null);
  const pendingServerRestoreRef = useRef<{
    readonly userId: string;
    readonly serverSettings: Partial<ServerSettings>;
  } | null>(null);

  const readCurrentThemePreferences = useStableCallback((): SyncedThemePreferences => {
    const halves: { light?: string; dark?: string } = {};
    if (theme.themeHalves?.light) halves.light = theme.themeHalves.light;
    if (theme.themeHalves?.dark) halves.dark = theme.themeHalves.dark;
    return sanitizeSyncedThemePreferences({
      themeId: theme.theme,
      appearanceMode: theme.appearanceMode,
      ...(halves.light !== undefined || halves.dark !== undefined ? { themeHalves: halves } : {}),
      typographyAdvanced,
    });
  });

  const canSyncLocalServerSettings = useStableCallback(
    () =>
      primaryServerSettings !== null &&
      canWritePrimarySettings &&
      pendingServerRestoreRef.current === null &&
      !serverRestoreBlockedRef.current,
  );

  const clearTimers = useStableCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    scheduledPushHashRef.current = null;
    if (echoReleaseTimerRef.current !== null) {
      window.clearTimeout(echoReleaseTimerRef.current);
      echoReleaseTimerRef.current = null;
    }
    if (followupTimerRef.current !== null) {
      window.clearTimeout(followupTimerRef.current);
      followupTimerRef.current = null;
    }
  });

  const scheduleEchoRelease = useStableCallback(() => {
    if (echoReleaseTimerRef.current !== null) {
      window.clearTimeout(echoReleaseTimerRef.current);
    }
    echoReleaseTimerRef.current = window.setTimeout(() => {
      echoReleaseTimerRef.current = null;
      applyingRemoteRef.current = false;
    }, 80);
  });

  const flushPendingServerRestore = useStableCallback(async () => {
    const pending = pendingServerRestoreRef.current;
    if (
      !pending ||
      !isLoaded ||
      !isSignedIn ||
      !user ||
      pending.userId !== user.id ||
      !primaryConnected ||
      primaryEnvironmentId === null ||
      primaryServerSettings === null ||
      !canWritePrimarySettings
    ) {
      return;
    }

    pendingServerRestoreRef.current = null;
    const rawPatch = buildServerSettingsRestorePatch(pending.serverSettings, primaryServerSettings);
    if (Object.keys(rawPatch).length === 0) {
      serverRestoreBlockedRef.current = false;
      return;
    }

    const decodedPatch = decodeClientServerSettingsPatch(rawPatch);
    if (Option.isNone(decodedPatch)) {
      serverRestoreBlockedRef.current = false;
      return;
    }

    applyingRemoteRef.current = true;
    try {
      const result = await persistServerSettings({
        environmentId: primaryEnvironmentId,
        input: { patch: decodedPatch.value },
      });
      if (result._tag === "Failure") {
        serverRestoreBlockedRef.current = true;
        setAccountSyncState({
          status: "error",
          lastError: gt("Could not apply server preferences during account sync."),
        });
      } else {
        serverRestoreBlockedRef.current = false;
      }
    } finally {
      scheduleEchoRelease();
    }
  });

  const applyRemotePayload = useStableCallback(
    async (
      payload: AccountCustomizationSyncPayload,
      userId: string,
      options?: { readonly notify?: boolean },
    ) => {
      clearTimers();
      applyingRemoteRef.current = true;
      setAccountSyncState({
        status: "restoring",
        lastError: null,
        pendingConflict: false,
      });

      try {
        // Restore allowlisted client settings without wiping trimmed or device-local keys.
        const clientPatch = buildClientSettingsRestorePatch(
          payload.clientSettings,
          payload.trimmedClientKeys,
        );
        if (Object.keys(clientPatch).length > 0) {
          await persistClientSettingsPatch(clientPatch);
        }

        // Apply theme state carefully: setTheme clears themeHalves, so restore halves afterward.
        if (payload.theme) {
          const {
            themeId,
            appearanceMode,
            themeHalves,
            typographyAdvanced: nextTypoAdv,
          } = payload.theme;
          if (themeId !== undefined && isKnownThemePreference(themeId)) {
            theme.setTheme(themeId);
          }
          if (themeHalves) {
            if (themeHalves.light && isKnownThemePreference(themeHalves.light)) {
              theme.setThemeHalf("light", themeHalves.light);
            }
            if (themeHalves.dark && isKnownThemePreference(themeHalves.dark)) {
              theme.setThemeHalf("dark", themeHalves.dark);
            }
          } else {
            theme.clearThemeHalves();
          }
          if (appearanceMode !== undefined) {
            theme.setAppearanceMode(appearanceMode);
          }
          if (nextTypoAdv !== undefined) {
            writeLocalStorageValue(
              TYPOGRAPHY_ADVANCED_STORAGE_KEY,
              nextTypoAdv,
              false,
              Schema.Boolean,
            );
          }
          theme.refreshTheme();
        }

        // Cache or apply server settings; mark blocked when environment is read-only until applied.
        existingCloudServerSettingsRef.current = payload.serverSettings ?? null;
        if (payload.serverSettings) {
          pendingServerRestoreRef.current = {
            userId,
            serverSettings: payload.serverSettings,
          };
          serverRestoreBlockedRef.current = !canWritePrimarySettings && primaryConnected;
          await flushPendingServerRestore();
        } else {
          pendingServerRestoreRef.current = null;
          serverRestoreBlockedRef.current = false;
        }

        const remoteHash = computeSyncContentHash({
          clientSettings: payload.clientSettings ?? {},
          theme: payload.theme ?? {},
          serverSettings: payload.serverSettings ?? {},
        });
        lastSyncedContentHashRef.current = remoteHash;
        lastSyncedCloudUpdatedAtRef.current = payload.updatedAt;

        const currentLocal = readAccountSyncLocalState();
        writeAccountSyncLocalState({
          ...currentLocal,
          lastSyncedUserId: userId,
          lastSyncedCloudUpdatedAt: payload.updatedAt,
          lastSyncedContentHash: remoteHash,
        });

        setAccountSyncState({
          status: "synced",
          lastSyncedUserId: userId,
          lastSyncedCloudUpdatedAt: payload.updatedAt,
          lastSyncedContentHash: remoteHash,
          cloudUpdatedAt: payload.updatedAt,
          cloudDeviceLabel: payload.deviceLabel ?? null,
          hasCloudBackup: true,
          lastError: null,
          pendingConflict: false,
        });

        if (options?.notify) {
          toastManager.add({
            type: "success",
            title: gt("Customizations synced"),
            description: gt("Restored your preferences from your T3 Code account."),
          });
        }
      } catch (error) {
        setAccountSyncState({
          status: "error",
          lastError:
            error instanceof Error
              ? error.message
              : gt("Could not restore customizations from your account."),
        });
      } finally {
        scheduleEchoRelease();
      }
    },
  );

  const buildLocalPayload = useStableCallback((): AccountCustomizationSyncPayload => {
    const syncLocalServer = canSyncLocalServerSettings();
    return buildAccountSyncPayload({
      clientSettings,
      theme: readCurrentThemePreferences(),
      serverSettings: syncLocalServer ? primaryServerSettings : null,
      existingCloudServerSettings: existingCloudServerSettingsRef.current,
      deviceLabel: resolveDeviceLabel(),
      now: new Date(),
    });
  });

  const saveToAccount = useStableCallback(async ({ force }: { readonly force: boolean }) => {
    if (!isLoaded || !isSignedIn || !user || !clientSettingsHydrated) {
      return;
    }
    if (pushInFlightRef.current) {
      queuedPushAfterFlightRef.current = true;
      return;
    }

    const payload = buildLocalPayload();
    const localHash = computeSyncContentHash(payload);
    if (!force && localHash === lastSyncedContentHashRef.current) {
      return;
    }

    pushInFlightRef.current = true;
    queuedPushAfterFlightRef.current = false;
    setAccountSyncState({ status: "syncing", lastError: null });

    try {
      const reloaded = await user.reload();
      if (activeUserIdRef.current !== reloaded.id) {
        return;
      }

      const remote = readAccountSyncPayloadFromMetadata(reloaded.unsafeMetadata);
      if (!force && remote !== null) {
        existingCloudServerSettingsRef.current = remote.serverSettings ?? null;
        const remoteHash = computeSyncContentHash(remote);
        if (remote.updatedAt !== lastSyncedCloudUpdatedAtRef.current && remoteHash !== localHash) {
          // Another device pushed newer customizations since our last sync; restore instead of overwriting.
          await applyRemotePayload(remote, reloaded.id, { notify: true });
          return;
        }
      }

      // Recompute payload in case reloaded metadata supplied cloud serverSettings while disconnected/blocked.
      const freshPayload = buildLocalPayload();
      const freshHash = computeSyncContentHash(freshPayload);
      const serialized = serializeAccountSyncMetadataValue(freshPayload, reloaded.unsafeMetadata);
      if (!serialized.ok) {
        const sizeMessage = gt(
          "Your customization backup exceeds the account metadata size limit ({bytes} bytes).",
          { bytes: serialized.totalMetadataBytes },
        );
        setAccountSyncState({ status: "error", lastError: sizeMessage });
        if (force) {
          toastManager.add({
            type: "error",
            title: gt("Could not save customizations"),
            description: sizeMessage,
          });
        }
        return;
      }

      await reloaded.updateMetadata({
        unsafeMetadata: {
          [CLERK_ACCOUNT_SYNC_METADATA_KEY]: serialized.json,
        },
      });

      const updatedAt = serialized.payload.updatedAt;
      const cloudDeviceLabel = serialized.payload.deviceLabel ?? null;
      existingCloudServerSettingsRef.current = serialized.payload.serverSettings ?? null;
      lastSyncedContentHashRef.current = freshHash;
      lastSyncedCloudUpdatedAtRef.current = updatedAt;

      const currentLocal = readAccountSyncLocalState();
      writeAccountSyncLocalState({
        ...currentLocal,
        lastSyncedUserId: reloaded.id,
        lastSyncedCloudUpdatedAt: updatedAt,
        lastSyncedContentHash: freshHash,
      });

      setAccountSyncState({
        status: "synced",
        lastSyncedUserId: reloaded.id,
        lastSyncedCloudUpdatedAt: updatedAt,
        lastSyncedContentHash: freshHash,
        cloudUpdatedAt: updatedAt,
        cloudDeviceLabel,
        hasCloudBackup: true,
        lastError: null,
        pendingConflict: false,
      });

      if (force) {
        toastManager.add({
          type: "success",
          title: gt("Customizations saved"),
          description: serialized.trimmed
            ? gt("Saved to your T3 Code account (large model preference maps trimmed).")
            : gt("Saved portable preferences to your T3 Code account."),
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : gt("Could not save customizations to your account.");
      setAccountSyncState({ status: "error", lastError: message });
      if (force) {
        toastManager.add({
          type: "error",
          title: gt("Could not save customizations"),
          description: message,
        });
      }
    } finally {
      pushInFlightRef.current = false;
      if (
        queuedPushAfterFlightRef.current &&
        isSignedIn &&
        readAccountSyncLocalState().autoSyncEnabled
      ) {
        queuedPushAfterFlightRef.current = false;
        if (followupTimerRef.current !== null) {
          window.clearTimeout(followupTimerRef.current);
        }
        followupTimerRef.current = window.setTimeout(() => {
          followupTimerRef.current = null;
          void saveToAccount({ force: false });
        }, IN_FLIGHT_FOLLOWUP_DELAY_MS);
      } else {
        queuedPushAfterFlightRef.current = false;
      }
    }
  });

  const restoreFromAccount = useStableCallback(async () => {
    if (!isLoaded || !isSignedIn || !user || !clientSettingsHydrated) {
      return;
    }
    setAccountSyncState({ status: "restoring", lastError: null });
    try {
      const reloaded = await user.reload();
      const remote = readAccountSyncPayloadFromMetadata(reloaded.unsafeMetadata);
      if (!remote) {
        const noBackupMessage = gt("No customization backup is stored on this account yet.");
        setAccountSyncState({
          status: "idle",
          hasCloudBackup: false,
          cloudUpdatedAt: null,
          cloudDeviceLabel: null,
          lastError: null,
        });
        toastManager.add({
          type: "info",
          title: gt("Nothing to restore"),
          description: noBackupMessage,
        });
        return;
      }
      await applyRemotePayload(remote, reloaded.id, { notify: true });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : gt("Could not load customizations from your account.");
      setAccountSyncState({ status: "error", lastError: message });
      toastManager.add({
        type: "error",
        title: gt("Restore failed"),
        description: message,
      });
    }
  });

  // Register imperative actions and clear timers on unmount.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers stable module-level callbacks once per mount
  useEffect(() => {
    const unregister = registerAccountSyncActions({
      saveNow: () => saveToAccount({ force: true }),
      restoreNow: () => restoreFromAccount(),
      setAutoSyncEnabled: (enabled) => {
        if (!enabled) {
          clearTimers();
        }
      },
    });
    return () => {
      unregister();
      clearTimers();
    };
  }, [clearTimers, restoreFromAccount, saveToAccount]);

  // Handle sign-in initialization and sign-out cleanup.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes external Clerk user lifecycle and local persistence
  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn || !user) {
      clearTimers();
      activeUserIdRef.current = null;
      initialRestoreSettledRef.current = false;
      queuedPushAfterFlightRef.current = false;
      serverRestoreBlockedRef.current = false;
      pendingServerRestoreRef.current = null;
      existingCloudServerSettingsRef.current = null;
      lastSyncedContentHashRef.current = null;
      lastSyncedCloudUpdatedAtRef.current = null;

      const currentLocal = readAccountSyncLocalState();
      writeAccountSyncLocalState({
        ...DEFAULT_ACCOUNT_SYNC_LOCAL_STATE,
        autoSyncEnabled: currentLocal.autoSyncEnabled,
      });
      setAccountSyncState({
        status: "idle",
        autoSyncEnabled: currentLocal.autoSyncEnabled,
        lastSyncedUserId: null,
        lastSyncedCloudUpdatedAt: null,
        lastSyncedContentHash: null,
        cloudUpdatedAt: null,
        cloudDeviceLabel: null,
        hasCloudBackup: false,
        lastError: null,
        pendingConflict: false,
      });
      return;
    }

    if (!clientSettingsHydrated) return;
    if (activeUserIdRef.current === user.id && initialRestoreSettledRef.current) {
      return;
    }

    activeUserIdRef.current = user.id;
    initialRestoreSettledRef.current = false;
    serverRestoreBlockedRef.current = false;
    let cancelled = false;

    const initializeForUser = async () => {
      try {
        const localState = readAccountSyncLocalState();
        const remote = readAccountSyncPayloadFromMetadata(user.unsafeMetadata);
        if (cancelled) return;

        if (remote !== null) {
          existingCloudServerSettingsRef.current = remote.serverSettings ?? null;
          setAccountSyncState({
            hasCloudBackup: true,
            cloudUpdatedAt: remote.updatedAt,
            cloudDeviceLabel: remote.deviceLabel ?? null,
          });
          if (
            localState.autoSyncEnabled &&
            (localState.lastSyncedUserId !== user.id ||
              localState.lastSyncedCloudUpdatedAt !== remote.updatedAt)
          ) {
            await applyRemotePayload(remote, user.id, { notify: true });
          } else {
            lastSyncedCloudUpdatedAtRef.current = remote.updatedAt;
            lastSyncedContentHashRef.current =
              localState.lastSyncedContentHash ?? computeSyncContentHash(remote);
            setAccountSyncState({
              status: "synced",
              lastSyncedUserId: user.id,
              lastSyncedCloudUpdatedAt: remote.updatedAt,
              lastSyncedContentHash: lastSyncedContentHashRef.current,
              lastError: null,
            });
          }
        } else {
          existingCloudServerSettingsRef.current = null;
          setAccountSyncState({
            hasCloudBackup: false,
            cloudUpdatedAt: null,
            cloudDeviceLabel: null,
          });
        }
      } finally {
        if (!cancelled) {
          initialRestoreSettledRef.current = true;
          if (isSignedIn && readAccountSyncLocalState().autoSyncEnabled) {
            const hash = computeSyncContentHash(buildLocalPayload());
            if (
              hash !== lastSyncedContentHashRef.current &&
              scheduledPushHashRef.current !== hash
            ) {
              if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current);
              }
              scheduledPushHashRef.current = hash;
              debounceTimerRef.current = window.setTimeout(() => {
                debounceTimerRef.current = null;
                scheduledPushHashRef.current = null;
                void saveToAccount({ force: false });
              }, AUTO_PUSH_DEBOUNCE_MS);
            }
          }
        }
      }
    };

    void initializeForUser();

    return () => {
      cancelled = true;
    };
  }, [clearTimers, clientSettingsHydrated, isLoaded, isSignedIn, user]);

  // Flush queued server-settings restore as soon as primary environment connects with write scope.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flushes queued server settings patch once RPC connection is ready
  useEffect(() => {
    if (
      !isLoaded ||
      !isSignedIn ||
      !user ||
      !primaryConnected ||
      primaryEnvironmentId === null ||
      primaryServerSettings === null ||
      !canWritePrimarySettings
    ) {
      return;
    }
    void flushPendingServerRestore();
  }, [
    canWritePrimarySettings,
    flushPendingServerRestore,
    isLoaded,
    isSignedIn,
    primaryConnected,
    primaryEnvironmentId,
    primaryServerSettings,
    user,
  ]);

  const themeHalfLight = theme.themeHalves?.light;
  const themeHalfDark = theme.themeHalves?.dark;

  // Watch portable customization changes without restarting the debounce timer on unrelated re-renders.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules debounced cloud backup when local portable settings change
  useEffect(() => {
    if (
      !isLoaded ||
      !isSignedIn ||
      !user ||
      !clientSettingsHydrated ||
      !initialRestoreSettledRef.current ||
      applyingRemoteRef.current
    ) {
      return;
    }

    const localState = readAccountSyncLocalState();
    if (!localState.autoSyncEnabled) return;

    const halves: { light?: string; dark?: string } = {};
    if (themeHalfLight) halves.light = themeHalfLight;
    if (themeHalfDark) halves.dark = themeHalfDark;
    const themeSnapshot = sanitizeSyncedThemePreferences({
      themeId: theme.theme,
      appearanceMode: theme.appearanceMode,
      ...(halves.light !== undefined || halves.dark !== undefined ? { themeHalves: halves } : {}),
      typographyAdvanced,
    });
    const canSyncServer =
      primaryServerSettings !== null &&
      canWritePrimarySettings &&
      pendingServerRestoreRef.current === null &&
      !serverRestoreBlockedRef.current;

    const currentHash = computeSyncContentHash({
      clientSettings: pickSyncableClientSettings(clientSettings),
      theme: themeSnapshot,
      serverSettings: canSyncServer
        ? pickSyncableServerSettings(primaryServerSettings)
        : (existingCloudServerSettingsRef.current ?? {}),
    });

    if (currentHash === lastSyncedContentHashRef.current) {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      scheduledPushHashRef.current = null;
      return;
    }

    if (currentHash === scheduledPushHashRef.current && debounceTimerRef.current !== null) {
      return;
    }

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    scheduledPushHashRef.current = currentHash;
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      scheduledPushHashRef.current = null;
      void saveToAccount({ force: false });
    }, AUTO_PUSH_DEBOUNCE_MS);
  }, [
    canWritePrimarySettings,
    clientSettings,
    clientSettingsHydrated,
    isLoaded,
    isSignedIn,
    primaryServerSettings,
    saveToAccount,
    theme.appearanceMode,
    theme.theme,
    themeHalfDark,
    themeHalfLight,
    typographyAdvanced,
    user,
  ]);

  return null;
}
