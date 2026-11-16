# Windows ARM computer as a GitHub Actions runner

Registers a Windows ARM computer (a VM is fine) as a self-hosted runner for this repository, so
`.github/workflows/desktop-e2e.yml` can build the desktop app's installer there, install it and drive the app end to end.
What the workflow checks is described in [desktop/README.md](../desktop/README.md#end-to-end-check-on-windows-arm).

Do the steps in order. Steps 1 to 3 are on the computer, 4 to 6 on github.com.

## 1. Prepare the computer

- Windows 11 on ARM64, with at least 4 CPUs, 8 GB of memory and 30 GB free disk. Turn off sleep
  (Settings > System > Power > Screen and sleep: Never).
- Outbound internet access to `github.com`, `*.githubusercontent.com`, `*.actions.githubusercontent.com`,
  `registry.npmjs.org`, `nodejs.org`, and the Playwright browser download hosts (the first browser test run downloads
  Chromium). No Python or Python package index access is needed.
- Install **Git for Windows** (the ARM64 installer from <https://git-scm.com/download/win>). Node.js is not needed: the
  workflow installs its own.
- Create a local standard user for the runner, for example `ghrunner`, and sign in as that user for the next steps. A
  separate user keeps the runner's files and the app's data (`%APPDATA%\D365FO Agent`) apart from your own.

## 2. Download and register the runner

1. On github.com open the repository, **Settings > Actions > Runners > New self-hosted runner**, and pick
   **Windows** and **ARM64**.
2. Open PowerShell as `ghrunner` and run the **Download** commands that page shows, in `C:\actions-runner`.
3. Run the **Configure** command it shows, adding a name:

   ```powershell
   .\config.cmd --url https://github.com/EGMamo/d365FO-Agentic --token <TOKEN FROM THE PAGE> --name win-arm-e2e
   ```

   Press Enter to keep the default runner group and work folder. The runner gets the labels `self-hosted`, `Windows`
   and `ARM64` on its own, which is what the workflow asks for. Answer **N** to "run as service" (see step 3).

The token on that page is valid for one hour; open the page again for a new one.

## 3. Keep it running, with a desktop

The app opens windows, so the runner must run in a signed-in desktop session, not as a Windows service (a service runs
without a desktop, where the app's window may not start).

1. Make Windows sign in to `ghrunner` on boot: download Autologon from Sysinternals
   (<https://learn.microsoft.com/sysinternals/downloads/autologon>), run it, enter the `ghrunner` password and click
   **Enable**.
2. Start the runner when `ghrunner` signs in. In an elevated PowerShell:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute 'C:\actions-runner\run.cmd' -WorkingDirectory 'C:\actions-runner'
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\ghrunner"
   $set     = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName 'GitHub Actions runner' -Action $action -Trigger $trigger -Settings $set -User "$env:COMPUTERNAME\ghrunner"
   ```

3. Restart the computer. On github.com, **Settings > Actions > Runners** should show `win-arm-e2e` as **Idle**.

Do not lock the session with a screen saver that logs off. If you disconnect from Remote Desktop, the session can lose its
screen; reconnect, or sign out and let Autologon sign back in.

If you would still rather run it as a service, answer **Y** in step 2 with `ghrunner` as the account and skip this step. If
the "App starts" check then fails, switch to this step.

## 4. Keep fork pull requests off this computer

This repository is public. The workflow never runs for pull requests from forks, and as a second guard set
**Settings > Actions > General > Fork pull request workflows from outside collaborators** to
**Require approval for all outside collaborators**.

## 5. Tell the workflow the runner exists (pull requests)

**Settings > Secrets and variables > Actions > Variables > New repository variable**: name `WINDOWS_ARM_RUNNER`, value
`true`. Until this is set, pull requests skip the e2e job instead of waiting for a runner. Manual runs do not need it.

Optional, to also run the sample login test case against a real F&O sandbox (dry run, so nothing is changed): add these
repository **secrets** on the same page. Use a test account without MFA in a sandbox, never production.

| Secret | Value |
| --- | --- |
| `E2E_ANTHROPIC_API_KEY` | An Anthropic API key for the agent's AI model |
| `E2E_D365_BASE_URL` | The sandbox address, `https://<name>.sandbox.operations.dynamics.com` |
| `E2E_D365_USERNAME` | The test account |
| `E2E_D365_PASSWORD` | Its password |
| `E2E_D365_COMPANY` | Optional: the legal entity, for example `USMF` |

All four of the first ones must be set for the F&O case to run; without them the rest of the check still runs. Azure DevOps
is not used.

## 6. Run it

**Actions > desktop-e2e > Run workflow**, pick the branch, and choose **arm64**. Tick **fresh** to delete the app's data
folder first, so Chat history, settings, and legacy migration state start empty as on a new computer. Leave **model**
off unless `E2E_ANTHROPIC_API_KEY` is configured and you want a real Chat request. The first run downloads Node.js,
Electron, and the npm packages, so it takes longer than later ones. The run's summary lists each check; the artifact
`desktop-e2e-win-arm64` holds screenshots, the app's log and the summary for 7 days, and `installer-win-arm64` the
installer it built for 3 days (manual runs only).

The **Run workflow** button appears once the workflow is on the default branch. Before that, the workflow runs on its pull
request once step 5 is done (push a commit or re-run the job).
