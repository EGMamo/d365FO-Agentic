# Sandbox validation

1. Open an existing installation and verify its environment IDs, report paths, and conversations survive migration. Check the private settings backup exists.
2. Save the real Settings form, reopen it, and confirm non-secret fields persist and secrets are masked. Test an unavailable server: edits must remain visible. Distinguish a saved configuration from a failed subsequent reload.
3. Test the shared Claude connection. Confirm Open WebUI discovers one local model and the D365FO tools. Restart and confirm disabled features remain disabled.
4. Select a local case and an Azure DevOps suite case through Tests. Verify the intended IDs and environment before running.
5. Run one representative real sandbox case with supplied credentials. Inspect verified expected results and screenshot/trace evidence. A mocked test or diagnostic dry run is not evidence of a working business flow.
6. Stop a run, verify partial reports and interrupted status, then manually rerun a selected case when safe.
7. Open previous results and upload a selected completed run using its own saved environment. Verify the DevOps link and outcome mapping.
8. Check the installed application on each supported desktop target. With Chat unavailable, Tests, Results, and Settings must still work.

Keep the fast automated suite for settings, authentication, outcomes, cancellation, reports/uploads, and guardrails. The desktop smoke test exercises actual form saving and rejects a model check whose JSON result says `ok: false`.
