# Open WebUI front end

[Open WebUI](https://openwebui.com) can drive the test runner from a chat. The settings app (`npm run ui` or the
desktop icon) also serves an **OpenAPI tool server** at `http://localhost:4365/tools`. Add it to Open WebUI once and
any chat model with tool calling can list profiles, write test cases, start and stop runs, read results and upload
them to Azure DevOps. The settings app stays the place to edit profiles and secrets; the tool server never returns
profile values.

## What the chat can do

| Tool | What it does |
| --- | --- |
| `list_profiles`, `use_profile` | See the saved environments and choose the one runs use |
| `list_test_cases`, `read_test_case`, `save_test_case` | Browse, read, create and edit local test cases in a project folder |
| `start_run` | Run a local folder or an Azure DevOps plan/suite, one case or all, dry run, retries, optional upload |
| `get_run`, `stop_run` | Follow the current run (it can wait up to 120 s for it to finish) and see the end of its log, or stop it |
| `get_results` | Totals and each case's outcome and failure reason, for the latest run or one from the history |
| `list_runs`, `upload_run` | Earlier runs with their DevOps links, and upload any of them to Azure DevOps later |

Only one run or upload happens at a time, shared with the settings app: a run started from chat shows up live in
the app's Run tab, and the other way round.

## Setup

1. Start the settings app: `npm run ui` (or double-click the desktop icon).
2. Start Open WebUI. With Docker:

   ```bash
   npm run openwebui:up      # uses openwebui/docker-compose.yml, Open WebUI on http://localhost:3000
   ```

   Any existing Open WebUI works too.
3. Get the address and key:

   ```bash
   npm run openwebui
   ```

4. In Open WebUI, add the tool server in one of two places:
   - **Admin Panel > Settings > External Tools** (for everyone on that Open WebUI; Open WebUI's server makes the calls):
     URL `http://host.docker.internal:4365/tools` when Open WebUI runs in Docker, type OpenAPI, path `openapi.json`,
     auth **Bearer** with the key.
   - **Settings > Tools** (just you; your browser makes the calls): URL `http://localhost:4365/tools`, auth Bearer with
     the key. This works with any Open WebUI, even a remote one, as long as the browser runs on the same computer as
     the settings app.
5. In a chat, enable the **D365FO test runner** tools (the + / tools button) and pick a model with tool calling. Setting
   the model's function calling to **Native** (Advanced Params) works best.

Try: *"Use the UAT profile, dry-run the cases in examples/testcases and tell me what failed."*

### Linux with Docker

On Linux the container cannot reach `127.0.0.1` on the host. Start the settings app with
`npm run ui -- --host 0.0.0.0`. Only the `/tools` routes, which need the key, answer on other addresses; the app
itself still refuses any request that is not addressed to `localhost`/`127.0.0.1`. Docker Desktop on Windows and
macOS does not need this.

## Security

- The key lives in `openwebui-token` in the agent home folder (owner-only). It is separate from the browser token, so
  the key pasted into Open WebUI never signs anyone in to the settings app. Delete the file and restart the app to
  issue a new key.
- The tool routes allow cross-origin calls (`Access-Control-Allow-Origin: *`) because they carry no cookies: a page
  that does not know the key gets `401`.
- Run logs returned to the chat have the active profile's secrets replaced with `***`, as in the app.

## Notes

- The chat model is whatever Open WebUI is set up with (`OPENAI_API_BASE_URL` / `OPENAI_API_KEY` or Ollama in the
  compose file). The test runs themselves still use the LLM configured in the active D365FO profile.
- The `appUrl` returned by `get_run` opens the settings app (Results tab for the HTML report), which needs the browser to have been signed in once
  from the launcher.
