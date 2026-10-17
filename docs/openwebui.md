# Open WebUI desktop integration

The packaged desktop keeps actual Open WebUI, pinned to version **0.11.4**, for its conversation layout, history, composer, markdown, themes, and branding. It runs locally with a slim Python installation managed by bundled uv. Docker and the duplicate built-in chat are no longer supported paths.

The desktop connects two local services automatically:

- The authenticated `/tools` OpenAPI bridge: select environments, list/read local or Azure DevOps cases, list Azure DevOps test plans and suites, check setup, start/stop/follow runs, read results/history with failure triage, and upload a selected result. Case editing stays in Tests; there is no chat tool for writing cases or managing learned pages.
- The authenticated `/model/v1` bridge: Open WebUI's native text/function-tool protocol is translated to the shared Claude adapter. The provider credentials stay in the Node settings service. Settings changes apply to subsequent requests without a second model picker.

Chat asks for confirmation before a real run or upload. Tests and Results retain direct action buttons and confirmations. Only one run or upload happens at a time. Use the active environment indicator to confirm the target.

## Following a long run

`get_run` waits up to 240 s (`waitSeconds`) and returns as soon as the run ends, so a short run needs one call. Each reply carries `progress` (cases finished out of the total, the case running now, and `remainingSeconds` estimated from the finished cases), `results` once a run has ended (the same summary as `get_results`, including each failed case's triage category and hint), and `next`: one sentence telling the model what to do now. While a job runs, `next` asks for another `get_run` call, which keeps weaker local models from stopping halfway. The wait stays under the 300 s after which Open WebUI and Node's `fetch` give up on a tool call. A run carries on when the chat stops following it.

## Reduced feature surface

The runtime disables general-purpose sharing, collaboration, notes, calendar, automations, web search, image/code execution, memories, cloud drives, extra model-generation calls, and direct connections through the pinned release's configuration controls. Model metadata disables file/vision/search/image/code capabilities; chat permissions also disable file/web upload, speech, calls, and multiple models. The app configures one model and the D365FO tool server by default.

`ENABLE_PERSISTENT_CONFIG=False` makes the app's environment settings authoritative on every startup, including existing installations. The same Open WebUI data directory is retained, preserving conversations and leaving old saved configuration available for rollback. Model and tool connection details are refreshed through Open WebUI's supported APIs.

Supported controls were checked against the pinned release's upstream `backend/open_webui/config.py`, `routers/tools.py`, and chat component. Some administrator settings may remain visible: the local no-auth user is an administrator, and permissions do not necessarily hide every upstream admin control. There is no CSS/DOM patch collection or Open WebUI fork to conceal them.

## Startup and recovery

First start downloads Python and Open WebUI; later starts reuse them. The settings pages are usable while Chat starts. If startup fails, the app reports the error and keeps Tests/Results/Settings available. Restart to retry Chat. No second chat implementation starts as a fallback.

The Open WebUI/Python footprint remains; reducing settings alone does not remove those dependencies. The app preserves upstream branding and required license notices. See [desktop/README.md](../desktop/README.md).
