import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type RsiTelemetrySummary } from "@t3tools/contracts";

import {
  hasNonZeroRsiCcrSavings,
  isRsiAuthorizationError,
  rsiEnvironment,
  sanitizeRsiQueryResult,
} from "./rsi";

function makeSummary(overrides?: Partial<RsiTelemetrySummary>): RsiTelemetrySummary {
  return {
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    loopTrips: 0,
    safetyBlocks: 0,
    totalToolErrors: 0,
    totalWastedReads: 0,
    totalTokens: 0,
    totalCachedInputTokens: 0,
    totalTokensSavedEst: 0,
    totalCompressedCalls: 0,
    totalCcrRetrievals: 0,
    ccrRetrievalRate: 0,
    avgCacheHitRate: 0,
    avgDurationMs: 0,
    byProvider: [],
    recentRuns: [],
    ...overrides,
  };
}

describe("rsi state helpers", () => {
  it("recognizes EnvironmentAuthorizationError failures cleanly", () => {
    expect(isRsiAuthorizationError({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(isRsiAuthorizationError({ _tag: "EnvironmentRpcUnavailableError" })).toBe(false);
    expect(isRsiAuthorizationError(null)).toBe(false);
    expect(isRsiAuthorizationError("forbidden")).toBe(false);
  });

  it("suppresses EnvironmentAuthorizationError while preserving other query failures", () => {
    const unauthorized = sanitizeRsiQueryResult({
      data: null,
      error: "Missing diagnostics.read permission",
      failure: { _tag: "EnvironmentAuthorizationError" },
      isPending: false,
      isSuccess: false,
    });
    expect(unauthorized.error).toBeNull();
    expect(unauthorized.failure).toBeNull();

    const transportError = sanitizeRsiQueryResult({
      data: null,
      error: "Connection closed",
      failure: { _tag: "EnvironmentRpcUnavailableError" },
      isPending: false,
      isSuccess: false,
    });
    expect(transportError.error).toBe("Connection closed");
    expect(transportError.failure).toEqual({ _tag: "EnvironmentRpcUnavailableError" });
  });

  it("detects non-zero CCR and cache savings cleanly", () => {
    expect(hasNonZeroRsiCcrSavings(null)).toBe(false);
    expect(hasNonZeroRsiCcrSavings(makeSummary())).toBe(false);
    expect(hasNonZeroRsiCcrSavings(makeSummary({ totalTokensSavedEst: 420 }))).toBe(true);
    expect(hasNonZeroRsiCcrSavings(makeSummary({ totalCompressedCalls: 2 }))).toBe(true);
    expect(hasNonZeroRsiCcrSavings(makeSummary({ totalCcrRetrievals: 1 }))).toBe(true);
    expect(hasNonZeroRsiCcrSavings(makeSummary({ avgCacheHitRate: 0.35 }))).toBe(true);
  });

  it("wires guarded commands and query atom families on rsiEnvironment", () => {
    const envId = EnvironmentId.make("env-rsi-test");
    expect(typeof rsiEnvironment.telemetrySummary({ environmentId: envId, input: {} })).toBe(
      "object",
    );
    expect(typeof rsiEnvironment.lessons({ environmentId: envId, input: {} })).toBe("object");
    expect(typeof rsiEnvironment.demoteLesson.permissionAtom(envId)).toBe("object");
    expect(typeof rsiEnvironment.deleteLesson.permissionAtom(envId)).toBe("object");
  });
});
