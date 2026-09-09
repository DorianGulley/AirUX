# AirUX Review setup

The AirUX Review plugin teaches Codex and Claude Code when and how to record a
localhost browser flow, submit it for private review, wait for the decision, and
act on feedback. The plugin and the local MCP server are installed separately;
your AirUX credential is never included in the plugin.

## Prerequisites

- Node.js 20 or newer
- Codex or Claude Code
- Access to the AirUX production application

The commands below use the initial production origin:
`https://airux-prod.airux-platform.workers.dev`. Replace it if AirUX has moved
to a custom domain.

## 1. Sign in and create an agent credential

1. Open `https://airux-prod.airux-platform.workers.dev` on a trusted device.
2. Select **Continue with GitHub** and finish sign-in.
3. Under **Agent credentials**, enter a name that identifies this agent
   environment, such as `Codex on laptop`.
4. Select **Create credential**, copy the displayed token, and store it
   securely. AirUX shows the token only once.

Use a different credential for each machine or agent environment so one can be
revoked without interrupting the others.

## 2. Install the browser used for recording

The AirUX MCP package uses Playwright 1.62.1. Install its Chromium build once:

```sh
npx -y playwright@1.62.1 install chromium
```

## 3. Connect the AirUX MCP server

The examples store the credential in the selected host's local MCP
configuration. Do not commit that configuration or paste the credential into a
repository file.

### Codex

```sh
codex mcp add airux \
  --env AIRUX_API_ORIGIN=https://airux-prod.airux-platform.workers.dev \
  --env AIRUX_AGENT_TOKEN='airux_agent_v1.CREDENTIAL_ID.SECRET' \
  -- npx -y @airux/mcp@0.1.0
```

Confirm the connection:

```sh
codex mcp list
```

### Claude Code

Install the server at user scope so it is available across projects:

```sh
claude mcp add --scope user airux \
  --env AIRUX_API_ORIGIN=https://airux-prod.airux-platform.workers.dev \
  --env AIRUX_AGENT_TOKEN='airux_agent_v1.CREDENTIAL_ID.SECRET' \
  -- npx -y @airux/mcp@0.1.0
```

Confirm the connection:

```sh
claude mcp get airux
```

## 4. Install the AirUX Review plugin

### Codex

Add the GitHub repository as a marketplace source:

```sh
codex plugin marketplace add DorianGulley/AirUX --ref main
codex plugin add airux-review@airux
```

Restart the agent host after installation. In the ChatGPT desktop app, the same
plugin is also available under **AirUX** in the Plugins Directory.

### Claude Code

```sh
claude plugin marketplace add DorianGulley/AirUX
claude plugin install airux-review@airux --scope user
```

Start a new Claude Code session, or run `/reload-plugins` in the current one.

## 5. Create the first Review

Start the web application you want to demonstrate on localhost, then ask the
agent naturally. For example:

> Record a short video showing that the Save button works on
> http://localhost:3000/settings and wait for my review.

The agent should inspect the page, create focused evidence, return the private
Review URL, and remain active while AirUX waits for your decision. Open the URL,
sign in with the same GitHub identity, then approve the claim or request changes.

## Revoke or rotate access

To rotate a credential without downtime, create and configure its replacement
before revoking the old one.

1. Open the AirUX production application and sign in.
2. Under **Agent credentials**, select **Revoke** beside the old credential.
   Revocation takes effect on the next authenticated AirUX request.
3. Remove the local MCP configuration if the environment should no longer have
   AirUX access:

   ```sh
   codex mcp remove airux
   # or
   claude mcp remove airux --scope user
   ```

Removing the plugin is separate from revoking the credential. In Codex, remove
**AirUX Review** in the Plugins Directory or run:

```sh
codex plugin remove airux-review@airux
codex plugin marketplace remove airux
```

In Claude Code, run:

```sh
claude plugin uninstall airux-review@airux --scope user
claude plugin marketplace remove airux
```

If a credential was exposed, revoke it before changing any local configuration.
