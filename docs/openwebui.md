# Open WebUI desktop integration

The packaged desktop keeps actual Open WebUI, pinned to version **0.11.4**, for its conversation layout, history, composer, markdown, themes, and branding. It runs locally with a slim Python installation managed by bundled uv. Docker and the duplicate built-in chat are no longer supported paths.

The desktop connects two local services automatically:

- The authenticated `/tools` OpenAPI bridge: select environments, list/read local or Azure DevOps cases, list Azure DevOps test plans and suites, check setup, start/stop/follow runs, read results/history with failure triage, and upload a selected result. Case editing stays in Tests; there is no chat tool for writing cases or managing learned pages.
- The authenticated `/model/v1` bridge: Open WebUI's native text/function-tool protocol is translated to the shared Claude adapter. The provider credentials stay in the Node settings service. Settings changes apply to subsequent requests without a second model picker.

Chat-triggered real runs and uploads require a native desktop confirmation enforced by the Node bridge, showing the actual target and selected cases. Model text or a confirmation flag cannot bypass this check; a browser-only server without a native approval callback refuses these tool mutations. Tests and Results retain direct action buttons and confirmations. The execution slot is reserved before asynchronous setup and held through history finalization, so only one run or upload happens at a time. Use the active environment indicator to confirm the target.

Open WebUI authentication remains enabled. Electron main injects a per-launch trusted-header capability only for the app's own chat view at its exact loopback origin; ordinary HTTP clients do not receive an administrator session. The bridge and Open WebUI accept only the registered chat origin for browser access. Provider secrets stay in the Node service.

## Following a long run

`get_run` waits up to 240 s (`waitSeconds`) and returns as soon as the run ends, so a short run needs one call. Each reply carries `progress` (cases finished out of the total, the case running now, and `remainingSeconds` estimated from the finished cases), `results` once a run has ended (the same summary as `get_results`, including each failed case's triage category and hint), and `next`: one sentence telling the model what to do now. While a job runs, `next` asks for another `get_run` call, which keeps weaker local models from stopping halfway. The wait stays under the 300 s after which Open WebUI and Node's `fetch` give up on a tool call. A run carries on when the chat stops following it.

## Reduced feature surface

The runtime disables general-purpose sharing, collaboration, notes, calendar, automations, web search, image/code execution, memories, cloud drives, extra model-generation calls, and direct connections through the pinned release's configuration controls. Model metadata disables file/vision/search/image/code capabilities; chat permissions also disable file/web upload, speech, calls, and multiple models. The app configures one model and the D365FO tool server by default.

`ENABLE_PERSISTENT_CONFIG=False` makes the app's environment settings authoritative on every startup, including existing installations. The same Open WebUI data directory is retained, preserving conversations and leaving old saved configuration available for rollback. Model and tool connection details are refreshed through Open WebUI's supported APIs.

Supported controls were checked against the pinned release's upstream `backend/open_webui/config.py`, `routers/tools.py`, and chat component. Some administrator settings may remain visible to the authenticated local desktop user. The app injects `desktop/shell/chat.css` for theme alignment and reduced-feature entry points; it preserves upstream branding and is not an Open WebUI fork. Access control is enforced independently of that stylesheet.

## Startup and recovery

First start downloads Python and Open WebUI; later starts reuse them. The settings pages are usable while Chat starts. If startup fails, the app reports the error and keeps Tests/Results/Settings available. Restart to retry Chat. No second chat implementation starts as a fallback.

The Open WebUI/Python footprint remains; reducing settings alone does not remove those dependencies. The app preserves upstream branding and required license notices. See [desktop/README.md](../desktop/README.md).
