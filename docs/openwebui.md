# Open WebUI front end

[Open WebUI](https://openwebui.com) can drive the test runner from a chat. The settings app (`npm run ui` or the
desktop app) also serves an **OpenAPI tool server** at `http://localhost:4365/tools`. Add it to Open WebUI once and
any chat model with tool calling can list profiles, write test cases, start and stop runs, read results and upload
them to Azure DevOps. The settings app stays the place to edit profiles and secrets; the tool server never returns
profile values.

## What the chat can do

| Tool | What it does |
| --- | --- |
| `list_profiles`, `use_profile` | See the saved environments and choose the one runs use |
| `list_test_cases`, `read_test_case`, `save_test_case` | Browse, read, create and edit local test cases in a project folder |
| `start_run` | Run a local folder or an Azure DevOps plan/suite, all cases or only some, dry run, retries, another AI model for this run only, optional upload |
| `get_run`, `stop_run` | Follow the current run or upload (it can wait up to 120 s for it to finish) and see the end of its log, or stop it |
| `get_results` | Totals and each case's outcome and failure reason, for the latest run or one from the history |
| `list_runs`, `upload_run` | Earlier runs with their DevOps links, and upload any of them to Azure DevOps later |
| `check_setup` | Run the setup check (`doctor`) on the profile in use and explain what is missing |
| `list_learned_pages` | The F&O forms the agent has learned while running tests, with visits, known controls and notes |

`get_run` also returns per-case progress (`finished`, `current`, and each case with its outcome so far), so the chat
can say "2 of 5 done, now running TC-AP-003".

Only one run or upload happens at a time, shared with the settings app: a run started from chat shows up live in
the app's Run tab, and the other way round.

## Setup

### Desktop app

The desktop app installs Open WebUI on first start, connects it to the tool server and keeps the address and key up
to date on every start. Nothing needs to be set up by hand. See [desktop/README.md](../desktop/README.md).

### By hand, or with an Open WebUI you already have

1. Start the settings app: `npm run ui`.
2. Get the address and key:

   ```bash
   npm run openwebui
   ```

   If port 4365 is taken, the settings app uses the next free port (up to 20 higher); this command shows the port of
   the running app.

3. In Open WebUI, add the tool server in one of two places:
   - **Admin Panel > Settings > External Tools** (for everyone on that Open WebUI; Open WebUI's server makes the calls):
     URL `http://host.docker.internal:4365/tools` when Open WebUI runs in Docker, type OpenAPI, path `openapi.json`,
     auth **Bearer** with the key.
   - **Settings > Tools** (just you; your browser makes the calls): URL `http://localhost:4365/tools`, auth Bearer with
     the key. This works with any Open WebUI, even a remote one, as long as the browser runs on the same computer as
     the settings app.
4. In a chat, enable the **D365FO test runner** tools and pick a model with tool calling.

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
- The tool routes allow cross-origin calls (`Access-Control-Allow-Origin: *`) because they carry no cookies. Only
  `/tools/openapi.json` (the tool descriptions) answers without the key; every other route returns `401` to a caller
  that does not send it.
- Run logs returned to the chat have the active profile's secrets replaced with `***`, as in the app.

## Notes

- The chat model is whatever Open WebUI is set up with (in the desktop app, the chat AI model picked above the chat).
  The test runs themselves still use the LLM configured in the active D365FO profile.
- The `appUrl` returned by `get_run` opens the settings app (Results tab for the HTML report), which needs the browser to have been signed in once
  from the address `npm run ui` opens.
