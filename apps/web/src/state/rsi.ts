import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type RsiGetTelemetrySummaryInput,
  type RsiQueryLessonsInput,
  type RsiTelemetrySummary,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "./query";
import { useEnvironmentScope } from "./session";

const DEFAULT_TELEMETRY_INPUT: RsiGetTelemetrySummaryInput = {};
const DEFAULT_LESSONS_INPUT: RsiQueryLessonsInput = {};

export const rsiEnvironment = {
  telemetrySummary: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:rsi:telemetry-summary",
    tag: WS_METHODS.rsiGetTelemetrySummary,
    staleTimeMs: 15_000,
    idleTtlMs: 2 * 60_000,
  }),
  lessons: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:rsi:lessons",
    tag: WS_METHODS.rsiQueryLessons,
    staleTimeMs: 15_000,
    idleTtlMs: 2 * 60_000,
  }),
  demoteLesson: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:rsi:demote-lesson",
    tag: WS_METHODS.rsiDemoteLesson,
  }),
  deleteLesson: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:rsi:delete-lesson",
    tag: WS_METHODS.rsiDeleteLesson,
  }),
};

export function isRsiAuthorizationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
  );
}

export function sanitizeRsiQueryResult<
  TResult extends {
    readonly error: string | null;
    readonly failure: unknown;
  },
>(query: TResult): TResult {
  if (!isRsiAuthorizationError(query.failure)) {
    return query;
  }
  return {
    ...query,
    error: null,
    failure: null,
  };
}

export function hasNonZeroRsiCcrSavings(summary: RsiTelemetrySummary | null | undefined): boolean {
  if (!summary) {
    return false;
  }
  return (
    summary.totalTokensSavedEst > 0 ||
    summary.totalCompressedCalls > 0 ||
    summary.totalCcrRetrievals > 0 ||
    summary.totalCachedInputTokens > 0 ||
    summary.avgCacheHitRate > 0
  );
}

export function useRsiTelemetrySummary(
  environmentId: EnvironmentId | null,
  input: RsiGetTelemetrySummaryInput = DEFAULT_TELEMETRY_INPUT,
) {
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(
    environmentId !== null && canReadDiagnostics
      ? rsiEnvironment.telemetrySummary({ environmentId, input })
      : null,
  );
  return sanitizeRsiQueryResult(query);
}

export function useRsiLessons(
  environmentId: EnvironmentId | null,
  input: RsiQueryLessonsInput = DEFAULT_LESSONS_INPUT,
) {
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(
    environmentId !== null && canReadDiagnostics
      ? rsiEnvironment.lessons({ environmentId, input })
      : null,
  );
  return sanitizeRsiQueryResult(query);
}

export function useRsiObservabilityRefresh(
  environmentId: EnvironmentId | null,
  options?: {
    readonly telemetryInput?: RsiGetTelemetrySummaryInput;
    readonly lessonsInput?: RsiQueryLessonsInput;
  },
) {
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const telemetryInput = options?.telemetryInput ?? DEFAULT_TELEMETRY_INPUT;
  const lessonsInput = options?.lessonsInput ?? DEFAULT_LESSONS_INPUT;
  const telemetryRefresh = useEnvironmentQueryRefresh(
    environmentId !== null && canReadDiagnostics
      ? rsiEnvironment.telemetrySummary({ environmentId, input: telemetryInput })
      : null,
  );
  const lessonsRefresh = useEnvironmentQueryRefresh(
    environmentId !== null && canReadDiagnostics
      ? rsiEnvironment.lessons({ environmentId, input: lessonsInput })
      : null,
  );
  return {
    refresh: () => {
      telemetryRefresh.refresh();
      lessonsRefresh.refresh();
    },
    isPending: () => telemetryRefresh.isPending() || lessonsRefresh.isPending(),
  };
}
