# Sandbox validation

1. Open an existing installation and verify its environment IDs, report paths, and conversations survive migration. Check the private settings backup exists.
2. Change the real Settings form to a value different from the fixture, require Save to succeed, reopen it, and confirm non-secret fields persist and secrets are masked. Restore the intended legal entity before running cases. Test an unavailable server: edits must remain visible. Distinguish a saved configuration from a failed subsequent reload.
3. Test the shared Claude connection. Confirm Open WebUI discovers one local model and the D365FO tools, and complete a chat/model/tool round trip. Verify an ordinary unauthenticated HTTP client cannot obtain an administrator session or bridge credentials. Restart and confirm disabled features remain disabled.
4. Select a local case and an Azure DevOps suite case through Tests. Verify the intended IDs and environment before running.
5. Run one representative real sandbox case with supplied credentials. Inspect verified expected results and screenshot/trace evidence. A mocked test or diagnostic dry run is not evidence of a working business flow.
6. Stop a run while it waits for the model and while it waits for a browser action. Verify no subsequent action is dispatched, partial reports retain interrupted status, and later cases do not run. Attempt simultaneous starts: exactly one must succeed. Then manually rerun a selected case when safe.
7. Open previous results and upload a selected completed run using its own saved environment. Verify the DevOps link and outcome mapping.
8. Check the installed application on each supported desktop target. With Chat unavailable, Tests, Results, and Settings must still work.
9. On a clean machine without system Node/npm, sign in with a browser, complete MFA, save the session, restart, and verify session renewal. Verify chat requests for live runs and uploads require a native approval and use precisely the environment/cases shown there.
10. Audit the staged Node application and locked Python runtime, retain their dependency inventories, and verify the release installer's signature/notarization. Exercise an upgrade failure and rollback using copied data before approving distribution.

Keep the fast automated suite for settings, authentication, outcomes, cancellation, reports/uploads, and guardrails. The desktop smoke test exercises actual form saving and rejects a model check whose JSON result says `ok: false`.
