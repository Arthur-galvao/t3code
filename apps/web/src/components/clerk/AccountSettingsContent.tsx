import { useAuth, useClerk, useUser } from "@clerk/react";
import { AuthAccessWriteScope, AuthRelayReadScope, AuthRelayWriteScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  CloudDownloadIcon,
  CloudUploadIcon,
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

import {
  requestAccountSyncRestore,
  requestAccountSyncSave,
  updateAccountAutoSyncEnabled,
  useAccountSyncState,
} from "../../cloud/accountCustomizationSync";
import { useManagedTunnelUsage } from "../../cloud/managedRelayState";
import { useEnvironmentScope } from "../../state/session";
import { TunnelUsageMeter } from "../cloud/TunnelUsage";
import { MobileAppSettingsRow } from "../settings/MobileAppSettingsRow";
import { CloudLinkRow } from "../settings/SavedEnvironmentRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
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
  const syncState = useAccountSyncState();
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

        {isLoaded && isSignedIn ? (
          <SettingsSection id="t3-account-sync" title={gt("Customization sync")}>
            <SettingsRow
              title={gt("Auto-sync customizations")}
              description={gt(
                "Automatically restore and sync theme, appearance, fonts, editor/chat preferences, and portable fork settings whenever you sign in. Secrets, local paths, custom CSS, and security toggles are never uploaded.",
              )}
              control={
                <Switch
                  aria-label={gt("Auto-sync customizations")}
                  checked={syncState.autoSyncEnabled}
                  onCheckedChange={(checked) => void updateAccountAutoSyncEnabled(Boolean(checked))}
                />
              }
            />
            <SettingsRow
              title={gt("Account backup")}
              description={
                syncState.status === "syncing"
                  ? gt("Saving portable customizations to your T3 Code account…")
                  : syncState.status === "restoring"
                    ? gt("Restoring customizations from your T3 Code account…")
                    : syncState.hasCloudBackup && syncState.cloudUpdatedAt
                      ? syncState.cloudDeviceLabel
                        ? gt("Last synced {timestamp} from {device}.", {
                            timestamp: new Date(syncState.cloudUpdatedAt).toLocaleString(),
                            device: syncState.cloudDeviceLabel,
                          })
                        : gt("Last synced {timestamp}.", {
                            timestamp: new Date(syncState.cloudUpdatedAt).toLocaleString(),
                          })
                      : gt("No customization backup is stored on this account yet.")
              }
              status={
                syncState.lastError ? (
                  <span className="text-destructive">{syncState.lastError}</span>
                ) : null
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={syncState.status === "syncing" || syncState.status === "restoring"}
                    onClick={() => void requestAccountSyncSave()}
                  >
                    <CloudUploadIcon className="size-3.5" />
                    <T>Save to account</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !syncState.hasCloudBackup ||
                      syncState.status === "syncing" ||
                      syncState.status === "restoring"
                    }
                    onClick={() => void requestAccountSyncRestore()}
                  >
                    <CloudDownloadIcon className="size-3.5" />
                    <T>Restore from account</T>
                  </Button>
                </div>
              }
            />
          </SettingsSection>
        ) : null}

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
