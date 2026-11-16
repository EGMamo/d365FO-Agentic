# App-owned Chat

Chat is part of the same local page as Tests, Results, and Settings. It uses the shared Claude connection in **Settings > AI connection** for model responses and tool calls. No Python runtime, second identity system, model picker, or Chat startup installation exists.

## User workflow

Create a conversation, ask about setup/cases/results, and follow model activity in the composer area. Conversations can be renamed and deleted. Enter sends a message; Shift+Enter adds a new line. Stop cancels the active model response; already persisted messages remain. Drafts are retained while switching conversations.

Chat can list and check environments, read cases and Azure DevOps plans, follow runs, explain and compare results, and upload selected runs. It cannot edit profiles or test-case files through model tools. Live runs, reruns, and uploads still show the desktop's native confirmation with the actual environment, source, cases, or upload plan. In browser-only development mode, those actions are refused unless the page itself supplies them; diagnostics remain available.

`get_run` waits up to 240 seconds and reports progress plus the next action. A test run continues if Chat stops following it. Chat events report status, tools, persisted messages, and errors over SSE. The current provider interface buffers its answer until the provider finishes; true token streaming remains a provider-level extension point described in [architecture.md](architecture.md).

## Conversation storage

New conversations are versioned JSON documents in the private agent home under `chats/`. Writes are atomic and serialized per conversation. User and assistant content plus the tool-call context needed by later provider turns are retained. Only recent history is sent to the provider, bounded by characters and starting at a user turn so tool calls remain paired; the file format is independent of `ChatService`, and another `ChatRepository` can replace storage later.

## Open WebUI migration

Older desktop releases stored conversations in Open WebUI's `webui.db`, inside Electron's user data under `openwebui/data`. On startup, the app reads this database directly and imports readable user/assistant messages from:

- the flat Open WebUI message list, when present;
- otherwise, the selected branch in Open WebUI's `history.messages` / `currentId` representation.

Internal Open WebUI tool traces are not replayed into the new provider's protocol. Empty conversations, archived conversations, and unreadable messages are skipped. Imported conversations are labeled in the Chat list.

Migration characteristics:

- **Non-destructive:** the old database, data directory, and Python runtime are not started, modified, or required. Existing legacy files can be backed up or removed through normal application-data administration after the user verifies the import.
- **Idempotent:** deterministic IDs and `importedFrom` markers prevent duplicate imports. A successful migration records its source size and modification time.
- **Crash-safe:** deleting only `legacy-chat-import.json` from the agent home forces a rescan; already imported conversations are skipped rather than duplicated. Do this only while the app is closed.
- **No new service:** SQLite is read lazily through Node's built-in reader only when an old `webui.db` is present, including conversations that are still committed in its WAL file. No database service or additional native dependency is started.

See [architecture.md](architecture.md) for ownership and extension points.
