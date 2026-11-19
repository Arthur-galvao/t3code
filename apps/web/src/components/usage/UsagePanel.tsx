import { useAtomValue } from "@effect/atom-react";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { collectLimitNotices } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";
import { isModelCostUnknown } from "@t3tools/shared/usageMerge";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import { resolveHour12 } from "../../timestampFormat";
import { ThreadDetailsContext } from "../chat/ThreadDetailsUsage";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { LimitWindows } from "./UsageLimits";
import { UsageModelDialog } from "./UsageModelDialog";
import { ProviderMark } from "./UsagePage";
import { sortModelsByTokens } from "./usageBreakdown";
import { limitWindowsByDriver, mostUsedWindow } from "./usageLimitsByProvider.logic";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  providersWithUsage,
  rankProvidersByMetric,
} from "./usageProviders";
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "./usageShortcuts";
import { useRefreshUsageLimits } from "./useRefreshUsageLimits";

const NO_HIDDEN_PROVIDERS: ReadonlySet<never> = new Set();
const DEFAULT_WINDOW_DAYS = 7;
const SPEND_METRICS = METRIC_OPTIONS.filter((option) => option.value !== "limits");
type SpendMetric = (typeof SPEND_METRICS)[number]["value"];

const windowFor = (days: number) => makeWindow(days, undefined, days === 1 ? "hour" : "day");

function Heading({ children }: { readonly children: string }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** Always-visible usage: the thread's context window, plus spend and limits per provider. */
export function UsagePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly contextWindow: ContextWindowSnapshot | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const [selection, setSelection] = useState(() => ({
    days: DEFAULT_WINDOW_DAYS,
    window: windowFor(DEFAULT_WINDOW_DAYS),
  }));
  const [metric, setMetric] = useState<SpendMetric>("cost");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshLimits = useRefreshUsageLimits(null, true);
  const { merged, shown, selectedEnvironments, refresh } = useUsage(
    selection.window,
    null,
    NO_HIDDEN_PROVIDERS,
  );
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);

  const data = shown?.merged ?? merged;
  const shownWindow = shown?.window ?? selection.window;
  const models = metric === "tokens" ? sortModelsByTokens(data.models) : data.models;
  const selectedModel = models.find((model) => `${model.provider}:${model.model}` === selectedKey);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const limitsByDriver = limitWindowsByDriver(
    pools.map((pool) => ({ driver: pool.driver, windows: displayLimitWindows(pool) })),
  );
  const withUsage = new Set(providersWithUsage(data.providers));
  const knownDrivers = new Set(
    PROVIDER_ORDER.map((kind) => PROVIDER_PRESENTATION[kind].driverKind),
  );
  const providers = rankProvidersByMetric(
    PROVIDER_ORDER.filter(
      (kind) => withUsage.has(kind) || limitsByDriver.has(PROVIDER_PRESENTATION[kind].driverKind),
    ),
    data.providers,
    metric,
  );
  const otherLimits = [...limitsByDriver].filter(([driver]) => !knownDrivers.has(driver));
  const notices = collectLimitNotices(presentations, messages);
  const metricValue = (totals: { costUsd: number; totalTokens: number } | undefined) =>
    metric === "cost" ? formatUsd(totals?.costUsd ?? 0) : formatTokens(totals?.totalTokens ?? 0);

  const refreshAll = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    void Promise.allSettled([refreshLimits(), refresh(selection.window)]).finally(() =>
      setIsRefreshing(false),
    );
  };

  return (
    <div
      data-usage-panel
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3"
      aria-label={gt("Usage")}
    >
      {props.contextWindow ? (
        <section data-usage-panel-section="context" className="flex flex-col gap-1">
          <Heading>{gt("Current thread context")}</Heading>
          <ThreadDetailsContext
            usage={props.contextWindow}
            environmentId={props.environmentId}
            threadId={props.threadId}
          />
        </section>
      ) : null}

      <section data-usage-panel-section="providers" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={gt("Usage period")}
            variant="segmented"
            value={[String(selection.days)]}
            onValueChange={(next) => {
              const days = Number(next[0]);
              if (WINDOW_OPTIONS.some((option) => option.days === days)) {
                setSelection({ days, window: windowFor(days) });
              }
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)}>
                {messages(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label={gt("Usage metric")}
            variant="segmented"
            value={[metric]}
            onValueChange={(next) => {
              const option = SPEND_METRICS.find((candidate) => candidate.value === next[0]);
              if (option) setMetric(option.value);
            }}
          >
            {SPEND_METRICS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {messages(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
          <Button
            onClick={refreshAll}
            aria-label={gt("Refresh usage and limits")}
            aria-busy={isRefreshing}
            disabled={isRefreshing}
            size="icon-sm"
            variant="ghost"
            className="ms-auto"
          >
            <RefreshIcon size="sm" refreshing={isRefreshing} />
          </Button>
        </div>
        {providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>No activity or limits to show.</T>
          </p>
        ) : (
          providers.map((provider) => {
            const totals = data.providers.find((entry) => entry.provider === provider);
            const driver = PROVIDER_PRESENTATION[provider].driverKind;
            const windows = limitsByDriver.get(driver) ?? [];
            const tightest = mostUsedWindow(windows);
            const providerModels = models.filter((model) => model.provider === provider);
            return (
              <Collapsible key={provider} data-usage-provider={provider}>
                <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-left text-sm">
                  <ChevronRightIcon
                    className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                    aria-hidden
                  />
                  <ProviderMark provider={provider} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">
                    {PROVIDER_PRESENTATION[provider].label}
                  </span>
                  {tightest ? (
                    <span
                      data-usage-limit-meter
                      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
                      aria-label={gt("{label}: {percent}% left", {
                        label: messages(tightest.label),
                        percent: remainingPercent(tightest),
                      })}
                    >
                      <span className="relative h-1 w-10 rounded-full bg-muted">
                        <span
                          className="absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: `${remainingPercent(tightest)}%`,
                            backgroundColor: PROVIDER_PRESENTATION[provider].color,
                          }}
                        />
                      </span>
                      {remainingPercent(tightest)}%
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-foreground tabular-nums">
                    {metricValue(totals)}
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="flex flex-col gap-2 pb-2 pl-5">
                    {windows.length > 0 ? (
                      <LimitWindows driver={driver} windows={windows} now={now} compact />
                    ) : null}
                    <ul className="flex flex-col">
                      {providerModels.map((model) => {
                        const key = `${model.provider}:${model.model}`;
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              onClick={() => setSelectedKey(key)}
                              className="flex w-full cursor-pointer items-baseline gap-2 py-1 text-left text-xs"
                            >
                              <span className="min-w-0 flex-1 truncate text-foreground">
                                {model.model}
                              </span>
                              <span className="shrink-0 text-muted-foreground tabular-nums">
                                {metric === "cost" && isModelCostUnknown(model)
                                  ? gt("Unpriced")
                                  : metricValue(model)}
                                {totals && totals.totalTokens > 0
                                  ? ` · ${formatPercent(model.totalTokens / totals.totalTokens)}`
                                  : ""}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            );
          })
        )}
        {otherLimits.map(([driver, windows]) => (
          <div key={driver} data-usage-panel-section="other-limits" className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{String(driver)}</span>
            <LimitWindows driver={driver} windows={windows} now={now} compact />
          </div>
        ))}
        {notices.map((notice) => (
          <p key={notice} className="text-xs text-muted-foreground">
            {notice}
          </p>
        ))}
      </section>

      <Button
        variant="ghost-muted"
        size="xs"
        className="self-start"
        onClick={() => void navigate({ to: "/usage" })}
      >
        <T>Open full usage page</T>
        <ExternalLinkIcon className="size-3.5" aria-hidden />
      </Button>

      {selectedModel ? (
        <UsageModelDialog
          model={selectedModel}
          environments={selectedEnvironments}
          metric={metric}
          chartWindow={{
            days: enumerateDays(shownWindow.sinceDay, shownWindow.untilDay),
            hours:
              shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
                ? []
                : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime),
            resolution: shownWindow.resolution === "hour" ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={() => void navigate({ to: "/usage" })}
          onClose={() => setSelectedKey(null)}
        />
      ) : null}
    </div>
  );
}
