# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment, with a T3-managed CLI installation and sign-in separate from your terminal or IDE.

## Set up Antigravity

1. Open **Settings → Providers** (web or desktop), choose your environment, and enable **Antigravity**.
2. Install the managed runtime (requires 1.25+ GiB free disk space; supports macOS Apple Silicon/Intel, Linux x64/ARM64 glibc/musl, and Windows x64/ARM64).
3. Click **Sign in** and complete browser sign-in. Wait for T3 Code to confirm access and load models. (Once installed, you can also sign in from mobile.)

- **Remote sign-in**: Paste the temporary code (or full URL) from Google's completion page into T3 Code's code field.
- **Manual binary**: Install [Antigravity CLI](https://antigravity.google/docs/getting-started) and set **Binary path** to `agy`. Leave blank to use the managed runtime (or `PATH`).
- **Updates**: Click **Update Antigravity** in provider settings. T3 Code requires Antigravity **1.5.1+** (1.5.12+ recommended); running threads finish on their original runtime.

### Sign-in methods

Choose **Sign-in method** in the Antigravity instance settings:

| Method                         | Credentials                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Google account**             | Personal Google browser sign-in                                         |
| **Gemini Enterprise**          | Browser sign-in, GCP project, and GCP location                          |
| **Gemini API key**             | API key (no browser required)                                           |
| **Agent Platform / Vertex AI** | API key, or GCP project + location with Application Default Credentials |

API keys are stored outside `settings.json`, and ambient `GEMINI_API_KEY` / Google env vars do not override the instance's configured method.

## Models, planning, and goals

- Models (including Claude and GPT when included in your plan) and thinking levels come from your Antigravity account.
- Use `/plan` for planning, `/compact` to summarize (if supported by your runtime), or `/clear` for a fresh session.
- **Edit from here** starts a fresh Antigravity session with the kept conversation history.
- **Native goals**: Send `/goal <objective>` when supported by your runtime. Use **Stop** to interrupt, then tell Antigravity to stop pursuing it before starting new work (`pause`/`resume`/`clear` are not supported).
- **Subagents**: Batched subagent activity is inspectable read-only via **Subagent work** (**Work** on mobile).
- Antigravity creates empty `.gemini/skills` and `.agents/skills` directories in workspaces on start (untracked by Git).

### Skills and attachments

- **Project skills**: Loaded in priority order from `.gemini/skills`, `.agents/skills`, then `.agent/skills`.
- **Global skills**: Loaded from `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills` (list `~/.agents/skills` in `~/.gemini/config/skills.json` or `.agents/skills.json` to include it).
- **Attachments**: Images and audio go directly to the model; PDFs and text files load as documents; videos and other files pass a saved file path (supported videos go natively to Gemini models).

## Multiple accounts and removal

Add a separate Antigravity instance in **Settings → Providers** for each Google account (runtimes are shared on disk).

| Action                              | Effect                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| **Disable**                         | Stops sessions; keeps saved login and history.                          |
| **Sign out** (or `/logout` in chat) | Stops sessions and removes saved login; keeps history.                  |
| **Remove downloaded runtime**       | Deletes shared runtime after instances are disabled; keeps credentials. |

## Usage and troubleshooting

- T3 Code does not read your Google account's Antigravity allowances; **Usage** shows tokens and cost from Antigravity's local history.
- Use **Refresh provider status** (web/desktop) or **Refresh models** (mobile) to reload models and access.
- For `SUBSCRIPTION_REQUIRED` or account restriction errors, see [Google's account plans](https://antigravity.google/docs/plans).

## Accounts and removal

Add an Antigravity provider instance for each Google account in
**Settings > Providers** on web or desktop. Each has its own sign-in; downloaded
runtimes are shared on the environment.

| Action                    | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| Disable                   | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out                  | Stops the instance's sessions and removes its saved Google login. |
| Remove downloaded runtime | Removes the shared installation and keeps Google credentials.     |

All three keep thread history and workspace files. Sending `/logout` by itself in
a thread signs out its instance, including stopping that instance's other sessions.
That needs a client allowed to manage providers, and it has to be your own message:
`/logout` from an agent or a scheduled task is refused.
Sign out, then sign in again to replace an account.

Before removing a managed runtime, disable its instances and cancel any active
installation. Clear any explicit binary path pointing into that runtime. Removal
is refused while the runtime is in use.

## Run a native goal

When your Antigravity runtime offers `/goal`, send `/goal` followed by a verifiable
objective. Antigravity keeps working until it completes the goal or you cancel it.

Use Stop to interrupt a running goal, then ask Antigravity to stop pursuing it
before starting more work. Ordinary follow-ups wait until the running turn ends.
T3 does not support Antigravity goal status, pause, resume, or clear commands.

## Check access and troubleshoot

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT allowances
for Google sign-ins. Each group has separate five-hour and weekly limits and reset
times. Limits refresh with provider status and include usage outside T3 Code.

Antigravity 1.5 and later keeps its Google sign-in in your system keyring (Keychain on
macOS, Credential Manager on Windows, Secret Service on Linux). T3 Code reads that sign-in
to check limits, so your keyring may ask you to allow access the first time. Antigravity
renews the sign-in only while it runs, so limits update when an Antigravity session starts.

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If asked to
sign in again, use provider settings on web or desktop, or **Settings > Providers** on mobile.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[plans]: https://antigravity.google/docs/plans
