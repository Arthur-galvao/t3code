import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { render } from "../../../test/render";
import { ThemeLibrary } from "./ThemeSettings";

describe("ThemeLibrary", () => {
  it("offers every built-in theme", async () => {
    const setTheme = vi.fn(() => true);
    await render(
      <ThemeLibrary
        theme="t3-chat"
        setTheme={setTheme}
        appearanceMode="dark"
        setAppearanceMode={() => true}
        customThemes={[]}
        initialAppearance="dark"
        refreshTheme={() => {}}
        isImportOpen={false}
        onImportOpenChange={() => {}}
        themeHalves={null}
        setThemeHalf={() => true}
      />,
    );

    for (const theme of BUILT_IN_THEMES) {
      await expect.element(page.getByText(theme.label, { exact: true })).toBeVisible();
    }
  });
});
