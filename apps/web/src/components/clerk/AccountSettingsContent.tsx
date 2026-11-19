import { useAuth, useClerk, useUser } from "@clerk/react";
import { AuthAccessWriteScope, AuthRelayReadScope, AuthRelayWriteScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  LogInIcon,
  LogOutIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SmartphoneIcon,
  UserRoundIcon,
} from "lucide-react";
import { useState } from "react";

import { useManagedTunnelUsage } from "../../cloud/managedRelayState";
import { useEnvironmentScope } from "../../state/session";
import { TunnelUsageMeter } from "../cloud/TunnelUsage";
import { MobileAppSettingsRow } from "../settings/MobileAppSettingsRow";
import { CloudLinkRow } from "../settings/SavedEnvironmentRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { retryClerkLoad, useClerkLoadFailed } from "./clerkLoadFailure";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function AccountSettingsContent() {
  const gt = useGT();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const accountPage = useT3ConnectAccountPage();
  const usage = useManagedTunnelUsage();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const { environment: accessEnvironment } = useAccessEnvironment(null);
  const accessEnvironmentId = accessEnvironment?.environmentId ?? null;
  const accessServerConfig = accessEnvironment?.serverConfig ?? null;
  const canReadRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayReadScope);
  const canManageRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayWriteScope);
  const canWriteAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope);

  const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? null;
  const displayName = user?.fullName || user?.username || primaryEmail || gt("T3 Code account");

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await clerk.signOut();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not sign out"),
        description: error instanceof Error ? error.message : gt("Try again."),
      });
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection id="t3-account" title={gt("T3 Code account")}>
          {loadFailed ? (
            <SettingsRow
              title={gt("Could not load T3 Connect")}
              description={gt(
                "T3 Connect authentication failed to load. Retry to sign in to your T3 Code account.",
              )}
              control={
                <Button size="sm" variant="outline" onClick={retryClerkLoad}>
                  <RotateCwIcon className="size-3.5" />
                  <T>Retry T3 Connect</T>
                </Button>
              }
            />
          ) : !isLoaded ? (
            <SettingsRow
              title={gt("Checking account…")}
              description={gt("Connecting to your T3 Code account status.")}
            />
          ) : !isSignedIn ? (
            <SettingsRow
              title={gt("Sign in to T3 Code")}
              description={gt(
                "Connect your T3 Code account to enable T3 Connect remote access, sync environments across devices, and pair the mobile app.",
              )}
              control={
                <Button size="sm" onClick={openAuthPrompt}>
                  <LogInIcon className="size-3.5" />
                  <T>Sign in</T>
                </Button>
              }
            />
          ) : (
            <>
              <SettingsRow
                title={
                  <span className="flex items-center gap-2.5">
                    {user?.imageUrl ? (
                      <img
                        src={user.imageUrl}
                        alt=""
                        className="size-7 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <UserRoundIcon className="size-4" />
                      </span>
                    )}
                    <span className="truncate">{displayName}</span>
                  </span>
                }
                description={
                  primaryEmail && displayName !== primaryEmail
                    ? gt("Signed in as {email}", { email: primaryEmail })
                    : gt("Signed in to T3 Connect.")
                }
                control={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => clerk.openUserProfile()}>
                      <T>Manage profile</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isSigningOut}
                      onClick={() => void handleSignOut()}
                    >
                      <LogOutIcon className="size-3.5" />
                      {isSigningOut ? gt("Signing out…") : gt("Sign out")}
                    </Button>
                  </div>
                }
              />

              {accountPage.open !== null ? (
                <SettingsRow
                  title={gt("Account & linked services")}
                  description={gt(
                    "Manage registered T3 Connect servers, paired mobile devices, and T3 Chat tunnel limits.",
                  )}
                  control={
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => accountPage.open?.("t3-connect")}
                      >
                        <ServerIcon className="size-3.5" />
                        <T>T3 Connect</T>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => accountPage.open?.("mobile-clients")}
                      >
                        <SmartphoneIcon className="size-3.5" />
                        <T>Mobile clients</T>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => accountPage.open?.("t3-chat")}
                      >
                        <MessageSquareIcon className="size-3.5" />
                        <T>T3 Chat</T>
                      </Button>
                    </div>
                  }
                />
              ) : null}

              {usage.used !== null && usage.limit !== null ? (
                <SettingsRow
                  title={gt("Managed tunnels")}
                  description={gt("Active T3 Connect tunnels on your account.")}
                  control={
                    <Button size="sm" variant="outline" onClick={usage.refresh}>
                      <RefreshCwIcon className="size-3.5" />
                      <T>Refresh</T>
                    </Button>
                  }
                >
                  <div className="pb-2">
                    <TunnelUsageMeter used={usage.used} limit={usage.limit} />
                  </div>
                </SettingsRow>
              ) : null}
            </>
          )}
        </SettingsSection>

        <SettingsSection id="t3-account-connect" title={gt("T3 Connect on this machine")}>
          {accessEnvironmentId !== null && (canReadRelay || canManageRelay) ? (
            <CloudLinkRow
              environmentId={accessEnvironmentId}
              canReadRelay={canReadRelay}
              canManageRelay={canManageRelay}
              connectDeviceApproval={
                accessServerConfig?.settings.requireConnectDeviceApproval === undefined
                  ? null
                  : {
                      required: accessServerConfig.settings.requireConnectDeviceApproval,
                      canManage: canWriteAccess,
                    }
              }
            />
          ) : (
            <SettingsRow
              title={gt("No active environment")}
              description={gt(
                "Connect to a local or remote environment to configure T3 Connect on it.",
              )}
            />
          )}

          <SettingsRow
            title={gt("Environments & access")}
            description={gt(
              "Manage saved machines, pairing links, Tailscale HTTPS, and authorized devices.",
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
      {accountPage.portals}
    </>
  );
}
