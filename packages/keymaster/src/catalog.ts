/**
 * Keymaster instruction catalog (DESIGN_AUTHORITY.md §6.11 K5.4): how to create each credential, per source system.
 *
 * Maintained by operations as data. Entries may be AI-drafted; a person reviews each one and approves it by setting
 * `approved: { by, at }` in a reviewed pull request. Until then the API and dashboard show the entry only with a
 * "pending human review" label. Every entry below was drafted by an AI and is unapproved.
 *
 * Instructions never contain a credential, and never ask anyone to run a script or paste a secret into a chat,
 * terminal, or repository (K5.6): values are supplied only through the Keymaster's write-only input.
 */

export type CatalogKind = 'static' | 'oauth';

export type CatalogEntry = {
  /** Catalog id; cartridges name it as a secret's `source` (or it is the OAuth connection's provider). */
  id: string;
  title: string;
  kind: CatalogKind;
  /** Markdown: how to create the credential. */
  instructions: string;
  /** Set by the person who reviewed the entry, in a reviewed PR. `null` = AI-drafted, pending human review. */
  approved: { by: string; at: string } | null;
};

export const PENDING_REVIEW_LABEL = 'Pending human review: AI-drafted instructions, not yet approved by a person.';

const SUPPLY = 'Paste the value into the write-only field on this page and save. It is stored in the factory\'s secret manager and is never shown again, here or anywhere else.';

export const INSTRUCTION_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'discord',
    title: 'Discord bot token',
    kind: 'static',
    approved: null,
    instructions: `1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and sign in with the account that should own the bot.
2. Choose **New Application**, name it after the agent, and accept the terms.
3. Open the **Bot** tab. Under **Privileged GatekeeperEgress Intents**, turn on only what the agent needs (usually **Message Content Intent**).
4. Choose **Reset Token**, confirm, and copy the token. Discord shows it once.
5. To add the bot to your server: **OAuth2** → **URL Generator**, tick the \`bot\` scope and the permissions the agent needs, open the generated URL, and pick the server.
6. ${SUPPLY}

If the token is ever exposed, choose **Reset Token** again and save the new one here; the old one stops working at once.`,
  },
  {
    id: 'github',
    title: 'GitHub fine-grained personal access token',
    kind: 'static',
    approved: null,
    instructions: `1. On GitHub, open **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. Name the token after the agent and set an **Expiration** (the factory will show the token as outstanding again once you replace it).
3. Pick the **Resource owner**. For an organization, an owner may have to approve the token before it works.
4. Under **Repository access**, choose **Only select repositories** and pick only the repositories the agent works on.
5. Under **Permissions**, grant the minimum the agent needs (for example **Contents: Read-only**, **Issues: Read and write**, **Pull requests: Read and write**). Leave everything else at **No access**.
6. Choose **Generate token** and copy it (it starts with \`github_pat_\`). GitHub shows it once.
7. ${SUPPLY}`,
  },
  {
    id: 'slack',
    title: 'Slack app token',
    kind: 'static',
    approved: null,
    instructions: `1. Open [Slack API: Your Apps](https://api.slack.com/apps) and choose **Create New App** → **From scratch**. Name it after the agent and pick the workspace.
2. Open **OAuth & Permissions** and, under **Bot Token Scopes**, add only the scopes the agent needs (for example \`chat:write\`, \`channels:history\`).
3. Choose **Install to Workspace** (a workspace admin may need to approve it) and allow the requested access.
4. Copy the **Bot User OAuth Token** (it starts with \`xoxb-\`).
5. If the agent's declaration asks for an app-level token instead (Socket Mode), open **Basic Information** → **App-Level Tokens**, create one with the \`connections:write\` scope, and copy it (it starts with \`xapp-\`).
6. Invite the bot to each channel it should use (\`/invite @your-bot\` in the channel).
7. ${SUPPLY}`,
  },
  {
    id: 'notion',
    title: 'Notion internal integration secret',
    kind: 'static',
    approved: null,
    instructions: `1. Open [Notion: My integrations](https://www.notion.so/profile/integrations) as a workspace owner and choose **New integration**.
2. Pick the workspace, set the type to **Internal**, and name the integration.
3. Under **Capabilities**, allow only what agents need (for example read and update content; no user information unless required). Save.
4. Open **Configuration**, choose **Show** next to **Internal Integration Secret**, and copy it (it starts with \`ntn_\`).
5. Share each page or database the integration may use: on the page, open **•••** → **Connections** → add the integration.
6. ${SUPPLY}

When the factory's gatekeeper-egress holds the Notion secret for the whole platform, agents never need their own; this page then shows it as managed by the platform.`,
  },
  {
    id: 'xai',
    title: 'xAI API key',
    kind: 'static',
    approved: null,
    instructions: `1. Sign in to the [xAI Console](https://console.x.ai) and open **API Keys**.
2. Choose **Create API Key**, name it, and restrict it to the models and endpoints the factory offers.
3. Copy the key (it starts with \`xai-\`). It is shown once.
4. ${SUPPLY}

Model provider keys are normally held by the factory's gatekeeper-egress for every agent (E5, S1) and are then shown as managed by the platform.`,
  },
  {
    id: 'anthropic',
    title: 'Anthropic API key',
    kind: 'static',
    approved: null,
    instructions: `1. Sign in to the [Anthropic Console](https://console.anthropic.com) and open **Settings** → **API Keys**.
2. Choose **Create Key**, pick the workspace whose limits and billing should apply, and name the key.
3. Copy the key (it starts with \`sk-ant-\`). It is shown once.
4. ${SUPPLY}

Model provider keys are normally held by the factory's gatekeeper-egress for every agent (E5, S1) and are then shown as managed by the platform.`,
  },
  {
    id: 'home-assistant',
    title: 'Home Assistant long-lived access token',
    kind: 'static',
    approved: null,
    instructions: `1. Consider creating a dedicated Home Assistant user for the agent (**Settings** → **People** → **Users**), without administrator rights unless the agent needs them, and sign in as that user.
2. Open your profile (your name at the bottom of the sidebar) and choose the **Security** tab.
3. Under **Long-lived access tokens**, choose **Create token**, name it after the agent, and copy it. Home Assistant shows it once; it is valid for ten years unless you delete it.
4. ${SUPPLY}

To revoke the agent's access, delete the token from the same list.`,
  },
  {
    id: 'google',
    title: 'Google account (OAuth consent)',
    kind: 'oauth',
    approved: null,
    instructions: `1. Choose **Connect** (or **Reconnect**). You are sent to Google's own sign-in page; the factory never sees your password.
2. Sign in with the Google account the agent should act for.
3. Review the access Google lists. It is exactly the scopes the agent declares. Choose **Continue** or **Allow**.
4. Google returns you to the factory, which stores the grant for this agent only. Follow the link back to this page; the connection shows as present.

If Google says the app is unverified or blocks the sign-in, the factory's OAuth app is still in testing: an administrator must add your account as a test user (Google Cloud console → **Google Auth Platform** → **Audience**).
Reconnect whenever this page shows missing scopes or "needs re-consent". You can revoke access at any time at [Google Account → Third-party connections](https://myaccount.google.com/connections).`,
  },
  {
    id: 'google-oauth-client',
    title: 'Google OAuth client (platform)',
    kind: 'static',
    approved: null,
    instructions: `The factory's Google OAuth app, shared by every agent that connects a Google account. Only needed once per factory.

1. In the [Google Cloud console](https://console.cloud.google.com), pick the factory's project and configure **Google Auth Platform** (branding, audience, and the data access scopes agents declare).
2. Open **Google Auth Platform** → **Clients** → **Create client**, choose **Web application**.
3. Under **Authorized redirect URIs**, add \`<the factory's public URL>/api/v1/connections/google/callback\`.
4. Choose **Create**, then download the client JSON.
5. Paste the whole JSON file contents into the write-only field on this page and save. It is never shown again.`,
  },
  {
    id: 'google-service-account',
    title: 'Google service account key (platform)',
    kind: 'static',
    approved: null,
    instructions: `The factory's Google service account, used for app-level Google access (not a person's data). Only needed once per factory.

1. In the [Google Cloud console](https://console.cloud.google.com), open **IAM & Admin** → **Service Accounts** and choose **Create service account**.
2. Grant it only the roles the declared scopes need (for example access to one storage bucket).
3. Open the service account → **Keys** → **Add key** → **Create new key** → **JSON**. Your organization's policy may forbid key creation; an administrator must then allow it for this project.
4. Paste the whole downloaded JSON file contents into the write-only field on this page and save, then delete the downloaded file. It is never shown again.`,
  },
];

export function catalogEntry(id: string | undefined): CatalogEntry | undefined {
  return id ? INSTRUCTION_CATALOG.find((e) => e.id === id) : undefined;
}

/** What callers see: the entry plus its review state. Unapproved entries always carry the pending-review label. */
export type CatalogView = CatalogEntry & { reviewState: 'approved' | 'pending_review'; label?: string };

export function catalogView(entry: CatalogEntry): CatalogView {
  return entry.approved
    ? { ...entry, reviewState: 'approved' }
    : { ...entry, reviewState: 'pending_review', label: PENDING_REVIEW_LABEL };
}

/** Name prefixes used to guess a source for secrets declared without one (older cartridges). Shown as inferred. */
const INFERRED_SOURCES: Array<[RegExp, string]> = [
  [/^DISCORD_/, 'discord'],
  [/^(GITHUB|GH)_/, 'github'],
  [/^SLACK_/, 'slack'],
  [/^NOTION_/, 'notion'],
  [/^XAI_/, 'xai'],
  [/^ANTHROPIC_/, 'anthropic'],
  [/^(HOME_ASSISTANT|HASS|HA)_/, 'home-assistant'],
];

export function inferSource(secretName: string): string | undefined {
  return INFERRED_SOURCES.find(([re]) => re.test(secretName))?.[1];
}
