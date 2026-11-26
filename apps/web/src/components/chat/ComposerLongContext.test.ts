import { describe, expect, it, vi } from "vite-plus/test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

import { longContextBannerItem, longContextWarningBandKey } from "./ComposerLongContext";

type ActionProps = { readonly children?: ReactNode; readonly onClick?: () => void };

function actionProps(node: ReactNode): ActionProps {
  if (!isValidElement<ActionProps>(node)) {
    throw new Error("expected a rendered action element");
  }
  return (node as ReactElement<ActionProps>).props;
}

function dismiss() {}

describe("longContextWarningBandKey", () => {
  it("bands usage in 150k steps", () => {
    expect(longContextWarningBandKey("thread-1", 150_000)).toBe("thread-1:1");
    expect(longContextWarningBandKey("thread-1", 299_999)).toBe("thread-1:1");
    expect(longContextWarningBandKey("thread-1", 300_000)).toBe("thread-1:2");
  });
});

describe("longContextBannerItem", () => {
  it("warns with the formatted token count", () => {
    const item = longContextBannerItem({
      usedTokens: 160_000,
      canCompact: false,
      canStartFresh: false,
      onDismiss: dismiss,
    });
    expect(item.id).toBe("antigravity-long-context");
    expect(item.variant).toBe("warning");
    expect(item.title).toContain("160k");
    expect(item.dismissLabel).toBe("Dismiss long context warning");
  });

  it("omits actions when neither action is available", () => {
    const item = longContextBannerItem({
      usedTokens: 200_000,
      canCompact: false,
      canStartFresh: false,
      onDismiss: dismiss,
    });
    expect(item).not.toHaveProperty("actions");
  });

  it("renders a single action when only one is available", () => {
    const onCompact = vi.fn();
    const item = longContextBannerItem({
      usedTokens: 200_000,
      canCompact: true,
      canStartFresh: false,
      onCompact,
      onDismiss: dismiss,
    });
    const actions = actionProps(item.actions);
    expect(actions.children).toBe("Compact");
    actions.onClick?.();
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("renders both actions side by side", () => {
    const onCompact = vi.fn();
    const onStartFresh = vi.fn();
    const item = longContextBannerItem({
      usedTokens: 200_000,
      canCompact: true,
      canStartFresh: true,
      onCompact,
      onStartFresh,
      onDismiss: dismiss,
    });
    const wrapper = actionProps(item.actions);
    const buttons = Children.toArray(wrapper.children);
    expect(buttons).toHaveLength(2);
    expect(actionProps(buttons[0]).children).toBe("Compact");
    expect(actionProps(buttons[1]).children).toBe("Start fresh session");
    actionProps(buttons[0]).onClick?.();
    actionProps(buttons[1]).onClick?.();
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onStartFresh).toHaveBeenCalledTimes(1);
  });
});
