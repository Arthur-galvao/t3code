import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ClientSettings,
} from "@t3tools/contracts";

export const CLERK_ACCOUNT_SYNC_METADATA_KEY = "t3codeSyncV1" as const;
export const ACCOUNT_SYNC_LOCAL_STATE_KEY = "t3code:account-sync:state:v1" as const;
export const MAX_CLERK_UNSAFE_METADATA_BYTES = 6_000 as const;

/** Strict allowlist of portable ClientSettings keys; excludes device-local, onboarding, and routing maps. */
export const SYNCABLE_CLIENT_SETTING_KEYS = [
  "notificationMode",
  "inAppNotificationsEnabled",
  "diffColorScheme",
  "chatWidth",
  "effortDisplay",
  "appearanceContrast",
  "panelAnimationDurationMs",
  "browserDefaultViewport",
  "browserDefaultZoomFactor",
  "browserDefaultAppearance",
  "browserRecordingFrameRate",
  "browserRecordingShowKeyPresses",
  "browserRecordingShowMousePresses",
  "browserLinkTarget",
  "browserSearchEngine",
  "browserCustomSearchUrl",
  "browserAutoShowFloatingPreview",
  "browserProfiles",
  "browserDefaultProfileId",
  "confirmQuit",
  "confirmThreadArchive",
  "confirmTerminalClose",
  "confirmThreadDelete",
  "confirmThreadUnpin",
  "diffFilesCollapsed",
  "diffIgnoreWhitespace",
  "diffLayout",
  "environmentIdentificationMode",
  "glassOpacity",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
  "fontFamilyCode",
  "fontFamilyComposer",
  "fontFamilySans",
  "fontFamilyTerminal",
  "fontSmoothing",
  "persistComposerContextStrip",
  "favorites",
  "providerModelPreferences",
  "pullRequestLinksOpenInApp",
  "composerRichTextEnabled",
  "sendShortcut",
  "followUpBehavior",
  "proactivePanelsEnabled",
  "showSkillsInSlashMenu",
  "boringSidebarEnabled",
  "boringSidebarMultilineRows",
  "toolCallVisibility",
  "screenReaderAnnouncements",
  "screenReaderWindowTitle",
  "threadDetailsUsageEnabled",
  "threadDetailsItems",
  "sidebarWorkingShelfEnabled",
  "sidebarProjectGroupingMode",
  "sidebarProjectSortOrder",
  "sidebarThreadSortOrder",
  "timestampFormat",
  "voiceShortcutMode",
  "speechLanguage",
  "speechTranslateToEnglish",
  "speechCustomWords",
  "speechSilenceFiltering",
  "speechStreaming",
  "speechRemoveFillerWords",
  "speechPostProcessingPrompt",
  "speechCorrectionWord",
  "language",
  "wordWrap",
  "mathRenderingEnabled",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

export type SyncableClientSettingKey = (typeof SYNCABLE_CLIENT_SETTING_KEYS)[number];

/**
 * Strict allowlist of portable, non-secret, non-path, non-security ServerSettings keys
 * present in both `ServerSettings.fields` and `ClientServerSettingsPatch.fields`.
 */
export const SYNCABLE_SERVER_SETTING_KEYS = [
  "rsiAutoDistillEnabled",
  "contextCompressionEnabled",
  "outputShaperEnabled",
  "verificationGateMode",
  "autoVerifyEnabled",
  "obsidianMemorySyncEnabled",
  "defaultThreadEnvMode",
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "responseStreamingMode",
  "autoFallbackOnUsageLimit",
  "snoozePresets",
  "sourceControlWritingStyle",
  "newWorktreesStartFromOrigin",
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleKeepPullRequests",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "threadTitleInstructions",
  "removeAgentCreditsOnMerge",
  "promptSuggestionsEnabled",
] as const satisfies ReadonlyArray<keyof ServerSettings>;

export type SyncableServerSettingKey = (typeof SYNCABLE_SERVER_SETTING_KEYS)[number];

export interface SyncedThemePreferences {
  readonly themeId?: string;
  readonly appearanceMode?: "light" | "dark" | "system";
  readonly themeHalves?: {
    readonly light?: string;
    readonly dark?: string;
  };
  readonly typographyAdvanced?: boolean;
}

export interface AccountCustomizationSyncPayload {
  readonly version: 1;
  readonly updatedAt: string;
  readonly deviceLabel?: string;
  readonly clientSettings?: Partial<ClientSettings>;
  readonly theme?: SyncedThemePreferences;
  readonly serverSettings?: Partial<ServerSettings>;
  readonly trimmedClientKeys?: ReadonlyArray<SyncableClientSettingKey>;
}

export interface AccountSyncLocalState {
  readonly autoSyncEnabled: boolean;
  readonly lastSyncedUserId: string | null;
  readonly lastSyncedCloudUpdatedAt: string | null;
  readonly lastSyncedContentHash: string | null;
}

export interface BuildAccountSyncPayloadInput {
  readonly clientSettings?: ClientSettings | null;
  readonly theme?: SyncedThemePreferences | null;
  readonly serverSettings?: ServerSettings | null;
  readonly existingCloudServerSettings?: Partial<ServerSettings> | null;
  readonly deviceLabel?: string | null;
  readonly now?: Date | string;
}

export type AccountSyncMetadataSerializationResult =
  | {
      readonly ok: true;
      readonly json: string;
      readonly bytes: number;
      readonly totalMetadataBytes: number;
      readonly trimmed: boolean;
      readonly trimmedKeys: ReadonlyArray<string>;
      readonly payload: AccountCustomizationSyncPayload;
    }
  | {
      readonly ok: false;
      readonly reason: "payload-too-large";
      readonly bytes: number;
      readonly totalMetadataBytes: number;
    };

export type AccountSyncStatus = "idle" | "syncing" | "restoring" | "synced" | "error";

export interface AccountSyncRuntimeState {
  readonly status: AccountSyncStatus;
  readonly autoSyncEnabled: boolean;
  readonly lastSyncedUserId: string | null;
  readonly lastSyncedCloudUpdatedAt: string | null;
  readonly lastSyncedContentHash: string | null;
  readonly lastError: string | null;
  readonly cloudUpdatedAt: string | null;
  readonly cloudDeviceLabel: string | null;
  readonly hasCloudBackup: boolean;
  readonly pendingConflict: boolean;
}

export interface AccountSyncActions {
  readonly saveNow: () => Promise<void>;
  readonly restoreNow: () => Promise<void>;
  readonly setAutoSyncEnabled: (enabled: boolean) => void | Promise<void>;
}

const SYNCABLE_CLIENT_SETTING_KEY_SET = new Set<string>(SYNCABLE_CLIENT_SETTING_KEYS);
const SYNCABLE_SERVER_SETTING_KEY_SET = new Set<string>(SYNCABLE_SERVER_SETTING_KEYS);
const VALID_APPEARANCE_MODES = new Set(["light", "dark", "system"]);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_THEME_ID_LENGTH = 128;
const MAX_DEVICE_LABEL_LENGTH = 120;
const UTF8_ENCODER = new TextEncoder();

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const FNV1A_64_MASK = 0xffffffffffffffffn;

const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

export const DEFAULT_ACCOUNT_SYNC_LOCAL_STATE: AccountSyncLocalState = {
  autoSyncEnabled: true,
  lastSyncedUserId: null,
  lastSyncedCloudUpdatedAt: null,
  lastSyncedContentHash: null,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!ISO_TIMESTAMP_PATTERN.test(trimmed)) return false;
  return Number.isFinite(Date.parse(trimmed));
}

function sanitizeThemeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_THEME_ID_LENGTH) return undefined;
  // Reject CSS-like payloads or multiline strings.
  if (/[\r\n{};]/.test(trimmed)) return undefined;
  return trimmed;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

function canonicalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalizeForHash(item)));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    const entry = record[key];
    if (entry === undefined) continue;
    sorted[key] = canonicalizeForHash(entry);
  }
  return sorted;
}

function fnv1a64Hex(input: string): string {
  const bytes = UTF8_ENCODER.encode(input);
  let hash = FNV1A_64_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV1A_64_PRIME) & FNV1A_64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function decodeClientSettingField(
  key: SyncableClientSettingKey,
  rawValue: unknown,
): Option.Option<unknown> {
  if (rawValue === undefined) return Option.none();
  const fieldSchema = ClientSettingsSchema.fields[key] as unknown as Schema.Codec<unknown, never>;
  return Schema.decodeUnknownOption(fieldSchema)(rawValue);
}

function decodeServerSettingField(
  key: SyncableServerSettingKey,
  rawValue: unknown,
): Option.Option<unknown> {
  if (rawValue === undefined) return Option.none();
  const fieldSchema = ServerSettings.fields[key] as unknown as Schema.Codec<unknown, never>;
  const decoded = Schema.decodeUnknownOption(fieldSchema)(rawValue);
  if (Option.isNone(decoded)) return Option.none();
  // `OmittedWhenNull(ThreadEnvMode)` coerces unknown non-null values to `null`; reject those.
  if (key === "defaultThreadEnvMode" && rawValue !== null && decoded.value === null) {
    return Option.none();
  }
  return decoded;
}

function sanitizeSyncableClientSettings(raw: unknown): Partial<ClientSettings> {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(raw)) {
    if (!SYNCABLE_CLIENT_SETTING_KEY_SET.has(key)) continue;
    const decoded = decodeClientSettingField(key as SyncableClientSettingKey, rawValue);
    if (Option.isSome(decoded)) {
      result[key] = decoded.value;
    }
  }
  return result as Partial<ClientSettings>;
}

function sanitizeSyncableServerSettings(raw: unknown): Partial<ServerSettings> {
  if (!isPlainObject(raw)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(raw)) {
    if (!SYNCABLE_SERVER_SETTING_KEY_SET.has(key)) continue;
    const decoded = decodeServerSettingField(key as SyncableServerSettingKey, rawValue);
    if (Option.isSome(decoded)) {
      result[key] = decoded.value;
    }
  }
  return result as Partial<ServerSettings>;
}

function encodeSyncableClientSettingsPatch(
  settings: Partial<ClientSettings>,
): Partial<ClientSettings> {
  const keys = Object.keys(settings).filter(
    (key) =>
      SYNCABLE_CLIENT_SETTING_KEY_SET.has(key) &&
      (settings as Record<string, unknown>)[key] !== undefined,
  );
  if (keys.length === 0) return {};
  const merged: Record<string, unknown> = { ...DEFAULT_CLIENT_SETTINGS };
  for (const key of keys) {
    merged[key] = (settings as Record<string, unknown>)[key];
  }
  const encoded = encodeClientSettings(merged as ClientSettings) as Record<string, unknown>;
  const encodedDefaults = encodeClientSettings(DEFAULT_CLIENT_SETTINGS) as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const key of keys) {
    if (!deepEqual(encoded[key], encodedDefaults[key])) {
      diff[key] = encoded[key];
    }
  }
  return diff as Partial<ClientSettings>;
}

function encodeSyncableServerSettingsPatch(
  settings: Partial<ServerSettings>,
): Partial<ServerSettings> {
  const keys = Object.keys(settings).filter(
    (key) =>
      SYNCABLE_SERVER_SETTING_KEY_SET.has(key) &&
      (settings as Record<string, unknown>)[key] !== undefined,
  );
  if (keys.length === 0) return {};
  const merged: Record<string, unknown> = { ...DEFAULT_SERVER_SETTINGS };
  for (const key of keys) {
    merged[key] = (settings as Record<string, unknown>)[key];
  }
  const encoded = encodeServerSettings(merged as ServerSettings) as Record<string, unknown>;
  const encodedDefaults = encodeServerSettings(DEFAULT_SERVER_SETTINGS) as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const key of keys) {
    const encodedValue = encoded[key];
    const encodedDefaultValue = encodedDefaults[key];
    if (!deepEqual(encodedValue, encodedDefaultValue)) {
      diff[key] = encodedValue;
    }
  }
  return diff as Partial<ServerSettings>;
}

/**
 * Returns only allowlisted `ClientSettings` keys whose values differ from `DEFAULT_CLIENT_SETTINGS`.
 */
export function pickSyncableClientSettings(settings: ClientSettings): Partial<ClientSettings> {
  const candidate: Record<string, unknown> = { ...DEFAULT_CLIENT_SETTINGS };
  for (const key of SYNCABLE_CLIENT_SETTING_KEYS) {
    if (settings[key] !== undefined) {
      candidate[key] = settings[key];
    }
  }
  const encoded = encodeClientSettings(candidate as ClientSettings) as Record<string, unknown>;
  const encodedDefaults = encodeClientSettings(DEFAULT_CLIENT_SETTINGS) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of SYNCABLE_CLIENT_SETTING_KEYS) {
    if (!deepEqual(encoded[key], encodedDefaults[key])) {
      picked[key] = encoded[key];
    }
  }
  return picked as Partial<ClientSettings>;
}

/**
 * Returns only allowlisted `ServerSettings` keys whose values differ from `DEFAULT_SERVER_SETTINGS`.
 */
export function pickSyncableServerSettings(settings: ServerSettings): Partial<ServerSettings> {
  const candidate: Record<string, unknown> = { ...DEFAULT_SERVER_SETTINGS };
  for (const key of SYNCABLE_SERVER_SETTING_KEYS) {
    if (settings[key] !== undefined) {
      candidate[key] = settings[key];
    }
  }
  const encoded = encodeServerSettings(candidate as ServerSettings) as Record<string, unknown>;
  const encodedDefaults = encodeServerSettings(DEFAULT_SERVER_SETTINGS) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of SYNCABLE_SERVER_SETTING_KEYS) {
    if (!deepEqual(encoded[key], encodedDefaults[key])) {
      picked[key] = encoded[key];
    }
  }
  return picked as Partial<ServerSettings>;
}

/**
 * Strips unknown keys, invalid appearance modes, and any raw CSS from synced theme preferences.
 */
export function sanitizeSyncedThemePreferences(theme: unknown): SyncedThemePreferences {
  if (!isPlainObject(theme)) return {};
  const sanitized: {
    themeId?: string;
    appearanceMode?: "light" | "dark" | "system";
    themeHalves?: { light?: string; dark?: string };
    typographyAdvanced?: boolean;
  } = {};

  const themeId = sanitizeThemeIdentifier(theme.themeId);
  if (themeId !== undefined) {
    sanitized.themeId = themeId;
  }

  if (
    typeof theme.appearanceMode === "string" &&
    VALID_APPEARANCE_MODES.has(theme.appearanceMode)
  ) {
    sanitized.appearanceMode = theme.appearanceMode as "light" | "dark" | "system";
  }

  if (isPlainObject(theme.themeHalves)) {
    const light = sanitizeThemeIdentifier(theme.themeHalves.light);
    const dark = sanitizeThemeIdentifier(theme.themeHalves.dark);
    if (light !== undefined || dark !== undefined) {
      sanitized.themeHalves = {
        ...(light !== undefined ? { light } : {}),
        ...(dark !== undefined ? { dark } : {}),
      };
    }
  }

  if (typeof theme.typographyAdvanced === "boolean") {
    sanitized.typographyAdvanced = theme.typographyAdvanced;
  }

  return sanitized;
}

/**
 * Builds a normalized `AccountCustomizationSyncPayload`.
 *
 * When `serverSettings` is `null` (e.g. primary server disconnected), `existingCloudServerSettings`
 * is preserved after allowlist & schema sanitization instead of wiping cloud server preferences.
 */
export function buildAccountSyncPayload(
  input: BuildAccountSyncPayloadInput,
): AccountCustomizationSyncPayload {
  let updatedAt: string;
  if (isValidIsoTimestamp(input.now)) {
    updatedAt = input.now.trim();
  } else if (input.now instanceof Date && Number.isFinite(input.now.getTime())) {
    updatedAt = input.now.toISOString();
  } else {
    updatedAt = new Date().toISOString();
  }

  const trimmedDeviceLabel =
    typeof input.deviceLabel === "string"
      ? input.deviceLabel.trim().slice(0, MAX_DEVICE_LABEL_LENGTH)
      : "";

  const clientSettings = input.clientSettings
    ? pickSyncableClientSettings(input.clientSettings)
    : undefined;
  const sanitizedTheme = input.theme ? sanitizeSyncedThemePreferences(input.theme) : undefined;

  let serverSettings: Partial<ServerSettings> | undefined;
  if (input.serverSettings !== null && input.serverSettings !== undefined) {
    serverSettings = pickSyncableServerSettings(input.serverSettings);
  } else if (input.existingCloudServerSettings) {
    serverSettings = encodeSyncableServerSettingsPatch(
      sanitizeSyncableServerSettings(input.existingCloudServerSettings),
    );
  }

  return {
    version: 1,
    updatedAt,
    ...(trimmedDeviceLabel.length > 0 ? { deviceLabel: trimmedDeviceLabel } : {}),
    ...(clientSettings && Object.keys(clientSettings).length > 0 ? { clientSettings } : {}),
    ...(sanitizedTheme && Object.keys(sanitizedTheme).length > 0 ? { theme: sanitizedTheme } : {}),
    ...(serverSettings && Object.keys(serverSettings).length > 0 ? { serverSettings } : {}),
  };
}

/**
 * Computes a deterministic 64-bit FNV-1a hex hash of synced customization content,
 * ignoring `version`, `updatedAt`, and `deviceLabel`, with canonical key ordering at every level.
 */
export function computeSyncContentHash(
  payloadOrSections:
    | AccountCustomizationSyncPayload
    | {
        readonly clientSettings?: Partial<ClientSettings>;
        readonly theme?: SyncedThemePreferences;
        readonly serverSettings?: Partial<ServerSettings>;
      },
): string {
  const sections: Record<string, unknown> = {};
  if (
    payloadOrSections.clientSettings &&
    Object.keys(payloadOrSections.clientSettings).length > 0
  ) {
    const normalizedClient = encodeSyncableClientSettingsPatch(
      sanitizeSyncableClientSettings(payloadOrSections.clientSettings),
    );
    if (Object.keys(normalizedClient).length > 0) {
      sections.clientSettings = normalizedClient;
    }
  }
  if (payloadOrSections.theme && Object.keys(payloadOrSections.theme).length > 0) {
    const normalizedTheme = sanitizeSyncedThemePreferences(payloadOrSections.theme);
    if (Object.keys(normalizedTheme).length > 0) {
      sections.theme = normalizedTheme;
    }
  }
  if (
    payloadOrSections.serverSettings &&
    Object.keys(payloadOrSections.serverSettings).length > 0
  ) {
    const normalizedServer = encodeSyncableServerSettingsPatch(
      sanitizeSyncableServerSettings(payloadOrSections.serverSettings),
    );
    if (Object.keys(normalizedServer).length > 0) {
      sections.serverSettings = normalizedServer;
    }
  }
  const canonicalJson = JSON.stringify(canonicalizeForHash(sections));
  return fnv1a64Hex(canonicalJson);
}

/**
 * Decodes and validates a cloud sync payload from either a JSON string or parsed object.
 * Invalid individual setting keys are dropped cleanly without discarding valid sibling keys.
 */
export function decodeAccountSyncPayload(raw: unknown): AccountCustomizationSyncPayload | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isValidIsoTimestamp(parsed.updatedAt)) return null;

  const deviceLabel =
    typeof parsed.deviceLabel === "string"
      ? parsed.deviceLabel.trim().slice(0, MAX_DEVICE_LABEL_LENGTH)
      : "";

  const clientSettings = sanitizeSyncableClientSettings(parsed.clientSettings);
  const theme = sanitizeSyncedThemePreferences(parsed.theme);
  const serverSettings = sanitizeSyncableServerSettings(parsed.serverSettings);
  const trimmedClientKeys = Array.isArray(parsed.trimmedClientKeys)
    ? Array.from(
        new Set(
          parsed.trimmedClientKeys.filter(
            (key): key is SyncableClientSettingKey =>
              typeof key === "string" && SYNCABLE_CLIENT_SETTING_KEY_SET.has(key),
          ),
        ),
      )
    : [];

  return {
    version: 1,
    updatedAt: parsed.updatedAt.trim(),
    ...(deviceLabel.length > 0 ? { deviceLabel } : {}),
    ...(Object.keys(clientSettings).length > 0 ? { clientSettings } : {}),
    ...(Object.keys(theme).length > 0 ? { theme } : {}),
    ...(Object.keys(serverSettings).length > 0 ? { serverSettings } : {}),
    ...(trimmedClientKeys.length > 0 ? { trimmedClientKeys } : {}),
  };
}

/**
 * Extracts and decodes the account customization sync payload from Clerk `unsafeMetadata`.
 */
export function readAccountSyncPayloadFromMetadata(
  unsafeMetadata: unknown,
): AccountCustomizationSyncPayload | null {
  if (!isPlainObject(unsafeMetadata)) return null;
  const raw = unsafeMetadata[CLERK_ACCOUNT_SYNC_METADATA_KEY];
  if (raw === undefined || raw === null) return null;
  return decodeAccountSyncPayload(raw);
}

function measureMetadataSerialization(
  payload: AccountCustomizationSyncPayload,
  baseMetadata: Record<string, unknown>,
): {
  readonly json: string;
  readonly bytes: number;
  readonly totalMetadataBytes: number;
} {
  const json = JSON.stringify(payload);
  const bytes = utf8ByteLength(json);
  const totalMetadataBytes = utf8ByteLength(
    JSON.stringify({
      ...baseMetadata,
      [CLERK_ACCOUNT_SYNC_METADATA_KEY]: json,
    }),
  );
  return { json, bytes, totalMetadataBytes };
}

function withoutClientSettingKey(
  payload: AccountCustomizationSyncPayload,
  key: "providerModelPreferences" | "favorites",
): AccountCustomizationSyncPayload {
  if (!payload.clientSettings || !(key in payload.clientSettings)) {
    return payload;
  }
  const nextClientSettings = { ...payload.clientSettings } as Record<string, unknown>;
  delete nextClientSettings[key];
  const { clientSettings: _ignored, ...rest } = payload;
  return Object.keys(nextClientSettings).length > 0
    ? { ...rest, clientSettings: nextClientSettings as Partial<ClientSettings> }
    : rest;
}

/**
 * Serializes an `AccountCustomizationSyncPayload` for Clerk `unsafeMetadata`, enforcing the
 * combined UTF-8 byte cap (`MAX_CLERK_UNSAFE_METADATA_BYTES`). If exceeded, progressively trims
 * `providerModelPreferences` and then `favorites` from `clientSettings` before returning
 * `{ ok: false, reason: "payload-too-large" }`.
 */
export function serializeAccountSyncMetadataValue(
  payload: AccountCustomizationSyncPayload,
  existingUnsafeMetadata?: Readonly<Record<string, unknown>> | null,
): AccountSyncMetadataSerializationResult {
  const baseMetadata: Record<string, unknown> = isPlainObject(existingUnsafeMetadata)
    ? { ...existingUnsafeMetadata }
    : {};

  let candidate: AccountCustomizationSyncPayload = {
    version: 1,
    updatedAt: payload.updatedAt,
    ...(payload.deviceLabel ? { deviceLabel: payload.deviceLabel } : {}),
    ...(payload.clientSettings && Object.keys(payload.clientSettings).length > 0
      ? { clientSettings: encodeSyncableClientSettingsPatch(payload.clientSettings) }
      : {}),
    ...(payload.theme && Object.keys(payload.theme).length > 0
      ? { theme: sanitizeSyncedThemePreferences(payload.theme) }
      : {}),
    ...(payload.serverSettings && Object.keys(payload.serverSettings).length > 0
      ? { serverSettings: encodeSyncableServerSettingsPatch(payload.serverSettings) }
      : {}),
  };

  if (candidate.clientSettings && Object.keys(candidate.clientSettings).length === 0) {
    const { clientSettings: _c, ...rest } = candidate;
    candidate = rest;
  }
  if (candidate.theme && Object.keys(candidate.theme).length === 0) {
    const { theme: _t, ...rest } = candidate;
    candidate = rest;
  }
  if (candidate.serverSettings && Object.keys(candidate.serverSettings).length === 0) {
    const { serverSettings: _s, ...rest } = candidate;
    candidate = rest;
  }

  let measured = measureMetadataSerialization(candidate, baseMetadata);
  if (measured.totalMetadataBytes <= MAX_CLERK_UNSAFE_METADATA_BYTES) {
    return {
      ok: true,
      ...measured,
      trimmed: false,
      trimmedKeys: [],
      payload: candidate,
    };
  }

  const trimmedKeys: SyncableClientSettingKey[] = [];
  for (const optionalKey of ["providerModelPreferences", "favorites"] as const) {
    if (candidate.clientSettings && optionalKey in candidate.clientSettings) {
      trimmedKeys.push(optionalKey);
      candidate = {
        ...withoutClientSettingKey(candidate, optionalKey),
        trimmedClientKeys: [...trimmedKeys],
      };
      measured = measureMetadataSerialization(candidate, baseMetadata);
      if (measured.totalMetadataBytes <= MAX_CLERK_UNSAFE_METADATA_BYTES) {
        return {
          ok: true,
          ...measured,
          trimmed: true,
          trimmedKeys,
          payload: candidate,
        };
      }
    }
  }

  return {
    ok: false,
    reason: "payload-too-large",
    bytes: measured.bytes,
    totalMetadataBytes: measured.totalMetadataBytes,
  };
}

/**
 * Builds a `ClientSettings` patch restoring allowlisted keys and resetting omitted ones to defaults,
 * matching the source device while leaving device-local keys (`voiceMicrophones`, `snapShot*`) intact.
 */
export function buildClientSettingsRestorePatch(
  cloudClientSettings: Partial<ClientSettings> | undefined,
  trimmedClientKeys?: ReadonlyArray<SyncableClientSettingKey>,
): Partial<ClientSettings> {
  const sanitized = sanitizeSyncableClientSettings(cloudClientSettings);
  const trimmedSet = new Set<string>(trimmedClientKeys ?? []);
  const patch: Record<string, unknown> = {};
  for (const key of SYNCABLE_CLIENT_SETTING_KEYS) {
    if (trimmedSet.has(key) && sanitized[key] === undefined) {
      continue;
    }
    patch[key] = sanitized[key] !== undefined ? sanitized[key] : DEFAULT_CLIENT_SETTINGS[key];
  }
  return patch as Partial<ClientSettings>;
}

/**
 * Builds a minimal `ServerSettings` patch containing only allowlisted keys whose target value
 * (from `cloudServerSettings`, or `DEFAULT_SERVER_SETTINGS` when omitted) differs from
 * `currentServerSettings`. Returns `{}` when no allowlisted server setting changed.
 */
export function buildServerSettingsRestorePatch(
  cloudServerSettings: Partial<ServerSettings> | undefined,
  currentServerSettings: ServerSettings,
): Partial<ServerSettings> {
  const sanitized = sanitizeSyncableServerSettings(cloudServerSettings);
  const patch: Record<string, unknown> = {};
  for (const key of SYNCABLE_SERVER_SETTING_KEYS) {
    const targetValue =
      sanitized[key] !== undefined ? sanitized[key] : DEFAULT_SERVER_SETTINGS[key];
    if (!deepEqual(currentServerSettings[key], targetValue)) {
      patch[key] = targetValue;
    }
  }
  return patch as Partial<ServerSettings>;
}

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis.window !== "undefined" ? globalThis.window.localStorage : null;
  } catch {
    return null;
  }
}

export function readAccountSyncLocalState(storage?: Storage | null): AccountSyncLocalState {
  const resolved = resolveStorage(storage);
  if (!resolved) return DEFAULT_ACCOUNT_SYNC_LOCAL_STATE;
  try {
    const raw = resolved.getItem(ACCOUNT_SYNC_LOCAL_STATE_KEY);
    if (!raw) return DEFAULT_ACCOUNT_SYNC_LOCAL_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return DEFAULT_ACCOUNT_SYNC_LOCAL_STATE;
    return {
      autoSyncEnabled:
        typeof parsed.autoSyncEnabled === "boolean"
          ? parsed.autoSyncEnabled
          : DEFAULT_ACCOUNT_SYNC_LOCAL_STATE.autoSyncEnabled,
      lastSyncedUserId:
        typeof parsed.lastSyncedUserId === "string" && parsed.lastSyncedUserId.length > 0
          ? parsed.lastSyncedUserId
          : null,
      lastSyncedCloudUpdatedAt:
        typeof parsed.lastSyncedCloudUpdatedAt === "string" &&
        parsed.lastSyncedCloudUpdatedAt.length > 0
          ? parsed.lastSyncedCloudUpdatedAt
          : null,
      lastSyncedContentHash:
        typeof parsed.lastSyncedContentHash === "string" && parsed.lastSyncedContentHash.length > 0
          ? parsed.lastSyncedContentHash
          : null,
    };
  } catch {
    return DEFAULT_ACCOUNT_SYNC_LOCAL_STATE;
  }
}

export function writeAccountSyncLocalState(
  state: AccountSyncLocalState,
  storage?: Storage | null,
): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved) return false;
  try {
    resolved.setItem(ACCOUNT_SYNC_LOCAL_STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

const initialLocalState = readAccountSyncLocalState();
let accountSyncState: AccountSyncRuntimeState = {
  status: "idle",
  autoSyncEnabled: initialLocalState.autoSyncEnabled,
  lastSyncedUserId: initialLocalState.lastSyncedUserId,
  lastSyncedCloudUpdatedAt: initialLocalState.lastSyncedCloudUpdatedAt,
  lastSyncedContentHash: initialLocalState.lastSyncedContentHash,
  lastError: null,
  cloudUpdatedAt: null,
  cloudDeviceLabel: null,
  hasCloudBackup: false,
  pendingConflict: false,
};

const accountSyncListeners = new Set<() => void>();
let registeredAccountSyncActions: AccountSyncActions | null = null;

function subscribeAccountSyncState(listener: () => void): () => void {
  accountSyncListeners.add(listener);
  return () => {
    accountSyncListeners.delete(listener);
  };
}

function emitAccountSyncStateChange(): void {
  for (const listener of accountSyncListeners) {
    listener();
  }
}

export function getAccountSyncState(): AccountSyncRuntimeState {
  return accountSyncState;
}

export function setAccountSyncState(patch: Partial<AccountSyncRuntimeState>): void {
  let changed = false;
  const nextState: Record<string, unknown> = { ...accountSyncState };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!Object.is(nextState[key], value)) {
      nextState[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  accountSyncState = nextState as unknown as AccountSyncRuntimeState;
  emitAccountSyncStateChange();
}

export function useAccountSyncState(): AccountSyncRuntimeState {
  return useSyncExternalStore(subscribeAccountSyncState, getAccountSyncState, getAccountSyncState);
}

export function registerAccountSyncActions(actions: AccountSyncActions | null): () => void {
  registeredAccountSyncActions = actions;
  return () => {
    if (registeredAccountSyncActions === actions) {
      registeredAccountSyncActions = null;
    }
  };
}

export async function requestAccountSyncSave(): Promise<void> {
  await registeredAccountSyncActions?.saveNow();
}

export async function requestAccountSyncRestore(): Promise<void> {
  await registeredAccountSyncActions?.restoreNow();
}

export async function updateAccountAutoSyncEnabled(enabled: boolean): Promise<void> {
  setAccountSyncState({ autoSyncEnabled: enabled });
  const currentLocal = readAccountSyncLocalState();
  writeAccountSyncLocalState({
    ...currentLocal,
    autoSyncEnabled: enabled,
  });
  await registeredAccountSyncActions?.setAutoSyncEnabled(enabled);
}
