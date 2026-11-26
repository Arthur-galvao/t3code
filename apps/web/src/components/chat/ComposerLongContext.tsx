import { msg } from "gt-react";
import { GaugeIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { formatContextWindowTokens } from "~/lib/contextWindow";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** A new band each 150k tokens, so a dismissal only covers the range it described. */
export function longContextWarningBandKey(
  threadKey: string,
  usedTokens: number,
  stepTokens = 150_000,
): string {
  return `${threadKey}:${Math.floor(usedTokens / stepTokens)}`;
}

/** Warns that Antigravity turns get slow and expensive above 150k input tokens. */
export function longContextBannerItem(
  {
    usedTokens,
    canCompact,
    canStartFresh,
    onCompact,
    onStartFresh,
    onDismiss,
  }: {
    readonly usedTokens: number;
    readonly canCompact: boolean;
    readonly canStartFresh: boolean;
    readonly onCompact?: () => void;
    readonly onStartFresh?: () => void;
    readonly onDismiss: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const compact =
    canCompact && onCompact ? (
      <Button size="xs" variant="ghost" onClick={onCompact}>
        {resolve(msg("Compact"))}
      </Button>
    ) : null;
  const startFresh =
    canStartFresh && onStartFresh ? (
      <Button size="xs" variant="ghost" onClick={onStartFresh}>
        {resolve(msg("Start fresh session"))}
      </Button>
    ) : null;
  const actions =
    compact && startFresh ? (
      <div className="flex items-center gap-1">
        {compact}
        {startFresh}
      </div>
    ) : (
      (compact ?? startFresh)
    );
  return {
    id: "antigravity-long-context",
    variant: "warning",
    icon: <GaugeIcon />,
    title: resolve(
      msg("Long context ({tokens} tokens)", { tokens: formatContextWindowTokens(usedTokens) }),
    ),
    description: resolve(
      msg(
        "Above 150k tokens, Antigravity input cost and latency rise sharply. Compact or start a fresh session.",
      ),
    ),
    ...(actions ? { actions } : {}),
    dismissLabel: resolve(msg("Dismiss long context warning")),
    onDismiss,
  };
}
