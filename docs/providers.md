# Claude connection

One shared connection serves Chat and all D365 test runs. Enter it in **Settings > AI connection**. There is no model catalog or per-run override.

- **API key:** from Anthropic or your company gateway.
- **Model name:** Advanced; defaults to `claude-opus-4-5-20251101`. Behind a gateway, use the exact name the gateway lists (for example `vertex_ai.anthropic.claude-sonnet-4`); `doctor` warns when the name is not in the gateway's model list.
- **API URL:** Advanced; an HTTPS endpoint. Leave it empty for Anthropic.
- **API format:** Advanced; how the endpoint is called.
  - *Claude Messages API* (default): `POST <url>/v1/messages`, as Anthropic and Claude-compatible gateways serve. A pasted `/v1` or `/v1/messages` is normalized.
  - *OpenAI-compatible (chat completions)*: `POST <url>/v1/chat/completions` with function calling, for gateways that only offer the OpenAI protocol in front of Claude (LiteLLM and most corporate GenAI services). A pasted `/v1` or `/v1/chat/completions` is normalized; an address without a version segment gets `/v1`. The key is sent as `Authorization: Bearer`.
- **Gateway bearer token:** Advanced; for Claude-format gateways that expect `Authorization: Bearer` instead of `x-api-key`. With the OpenAI format it takes precedence over the API key.

**Test connection** makes a real model request and reports failure even if the local HTTP request completed normally. Save errors preserve form entries. A successful save followed by a status reload failure is reported separately.

The desktop stores the connection in `ai.env` in the agent's private settings folder. Secret values are masked when read by the settings page and redacted from Chat errors. Chat uses the same provider interface as the runner; it supports text and native function tools, not file/image/audio input. Responses are buffered until the model finishes, while status and tool progress stream to the page over SSE.

For the CLI, use `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, `LLM_API_FORMAT` (`anthropic` or `openai`) and `LLM_MODEL` in `.env`. Real process variables always take precedence.

## When a company gateway does not connect

Run **Check setup** (or `node dist/cli/index.js doctor`). It prints the network setup, the API format, and whether `<url>/v1/models` answers:

| What you see | Likely cause | What to change |
|---|---|---|
| `NOT REACHABLE ... ENOTFOUND` / `ECONNREFUSED` / timeout | Not on the company network or VPN, or a proxy is required | Connect the VPN; set `HTTPS_PROXY` if your network needs one |
| `self-signed certificate in certificate chain` / `unable to get local issuer certificate` | TLS inspection with a company root certificate | Ensure the root is in the OS store (IT normally installs it), or set `NODE_EXTRA_CA_CERTS` to its PEM file |
| HTTP 404 on test, model list works | Wrong API format | Switch **API format** to OpenAI-compatible (or back) |
| HTTP 401/403 | Key refused, or wrong header | Check the key; for Claude format try the bearer token field instead |
| "did not accept the model name" | The gateway uses its own model names | Copy a name from the model list `doctor` prints |

## Corporate networks

Each process (the desktop app and every run it starts) prepares Node's networking once at start-up:

- **Certificates:** the operating system's certificate store is trusted in addition to Node's bundled list, so a TLS-inspecting proxy's company root works without configuration. `NODE_EXTRA_CA_CERTS=<file.pem>` adds a root that is not in the OS store. `D365FO_SYSTEM_CA=false` turns the OS store off.
- **Proxy:** `HTTPS_PROXY` / `HTTP_PROXY` route model, Azure DevOps and Microsoft Learn calls; `NO_PROXY` is honoured and the app's own `localhost` services are always direct. The desktop app, which does not inherit a terminal's variables, adopts the operating system's proxy when it is one fixed proxy for both the model endpoint and Azure DevOps. A PAC file that routes hosts differently is not applied automatically: set `HTTPS_PROXY` explicitly if you need it. `D365FO_SYSTEM_PROXY=false` turns the adoption off.
- The F&O browser (Chromium via Playwright) uses the operating system's proxy and certificates on its own.

These need the Node 24 runtime that ships with the desktop app. On an older Node, `doctor` prints a note and requests go direct with Node's bundled certificates.

Existing selected chat connections are migrated when usable, otherwise the active environment's Claude connection is used. Previous provider settings remain in a private configuration backup. Existing reports and conversations are not deleted.
