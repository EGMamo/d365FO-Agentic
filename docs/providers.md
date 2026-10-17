# Claude connection

This release supports one shared Claude connection for Open WebUI Chat and all D365 test runs. Enter it in **Settings > Shared AI connection**. There is no model catalog or per-run override.

- **API key:** from Anthropic or your corporate gateway.
- **Model name:** Advanced; defaults to `claude-opus-4-5-20251101`.
- **Claude API URL:** Advanced; an HTTPS Claude-compatible endpoint. A trailing `/v1` or `/v1/messages` is normalized by the adapter.
- **Gateway bearer token:** Advanced; for gateways that expect bearer authentication instead of an API key.

**Test connection** makes a real model request and reports failure even if the local HTTP request completed normally. Save errors preserve form entries. A successful save followed by a status reload failure is reported separately.

The desktop stores the connection in `ai.env` in the agent's private settings folder. Secret values are masked when read by the settings page. The local model bridge translates Open WebUI's protocol into the same Claude adapter the runner uses; Open WebUI receives a local bridge token rather than the provider key. It supports text and native function tools, not file/image/audio input. Responses are buffered until Claude finishes, then returned in Open WebUI's requested protocol.

For CLI fallback, use `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, and `LLM_MODEL` in `.env`. Real process variables always take precedence.

Existing selected chat connections are migrated when usable, otherwise the active environment's Claude connection is used. Previous provider settings remain in a private configuration backup; unsupported providers require entering a Claude connection. Existing reports and conversations are not deleted.
