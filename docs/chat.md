# App-owned Chat

Chat is part of the same local page as Tests, Results, and Settings. It uses the shared Claude connection in **Settings > AI connection** for model responses and tool calls. No Python runtime, second identity system, model picker, or Chat startup installation exists.

## User workflow

Create a conversation, ask about setup/cases/results, and follow model activity in the composer area. Conversations can be renamed and deleted. Enter sends a message; Shift+Enter adds a new line. Stop cancels the active model response; already persisted messages remain. Drafts are retained while switching conversations.

Chat can list and check environments, read cases and Azure DevOps plans, follow runs, explain and compare results, and upload selected runs. It cannot edit profiles or test-case files through model tools. Live runs, reruns, and uploads still show the desktop's native confirmation with the actual environment, source, cases, or upload plan. In browser-only development mode, those actions are refused unless the page itself supplies them; diagnostics remain available.

`get_run` waits up to 240 seconds and reports progress plus the next action. A test run continues if Chat stops following it. Chat events report status, tools, persisted messages, and errors over SSE. The current provider interface buffers its answer until the provider finishes; true token streaming remains a provider-level extension point described in [architecture.md](architecture.md).

## Conversation storage

New conversations are versioned JSON documents in the private agent home under `chats/`. Writes are atomic and serialized per conversation. User and assistant content plus the tool-call context needed by later provider turns are retained. Only recent history is sent to the provider, bounded by characters and starting at a user turn so tool calls remain paired; the file format is independent of `ChatService`, and another `ChatRepository` can replace storage later.

Conversations start empty. The app does not read, import or modify data from any previous chat runtime; older conversation files stay in their own folders and can be removed through normal application-data administration.

See [architecture.md](architecture.md) for ownership and extension points.
