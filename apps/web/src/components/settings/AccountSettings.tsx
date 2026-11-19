import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { lazy, Suspense } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Button } from "../ui/button";
import { MobileAppSettingsRow } from "./MobileAppSettingsRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AccountSettingsContent = lazy(() =>
  import("../clerk/AccountSettingsContent").then((module) => ({
    default: module.AccountSettingsContent,
  })),
);

export function AccountSettings() {
  const gt = useGT();

  if (!hasCloudPublicConfig()) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="t3-account" title={gt("T3 Code account")}>
          <SettingsRow
            title={gt("T3 Connect is not configured")}
            description={gt(
              "This build does not include T3 Connect public configuration ({vars}), so cloud account sign-in is unavailable. You can still pair environments manually or connect the mobile app.",
              { vars: "T3CODE_CLERK_PUBLISHABLE_KEY / T3CODE_RELAY_URL" },
            )}
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
                  <T>Environments</T>
                </Button>
                <Button size="sm" variant="outline" render={<Link to="/settings/access" />}>
                  <T>Sharing & access</T>
                </Button>
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection id="t3-account-mobile" title={gt("Mobile app")}>
          <MobileAppSettingsRow />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <Suspense
      fallback={
        <SettingsPageContainer>
          <SettingsSection id="t3-account" title={gt("T3 Code account")}>
            <SettingsRow title={gt("Loading account…")} />
          </SettingsSection>
        </SettingsPageContainer>
      }
    >
      <AccountSettingsContent />
    </Suspense>
  );
}
