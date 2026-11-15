import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useEffectEvent } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Refreshes provider limits on the selected environments; `autoRefresh` also runs it when the connected set changes. */
export function useRefreshUsageLimits(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  autoRefresh: boolean,
) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshLimits = (automatic = false) =>
    // Settled so callers' bookkeeping still runs when a refresh throws.
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  const connectedKey = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits from the server when the connected environment set changes
  useEffect(() => {
    if (autoRefresh && connectedKey) autoRefreshLimits();
  }, [autoRefresh, connectedKey]);
  return refreshLimits;
}
