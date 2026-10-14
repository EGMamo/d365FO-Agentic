# Skills for coding agents

[`d365fo-playwright-cli`](d365fo-playwright-cli/SKILL.md) is a `SKILL.md` skill that lets a coding agent (Claude Code,
GitHub Copilot in VS Code, and other agents that read `SKILL.md` skills) test D365 Finance & Operations through
[playwright-cli](https://github.com/microsoft/playwright-cli). It gives the agent what this app knows about F&O: direct
form links (`?cmp=<company>&mi=<menu item>`), AOT control names (`data-dyn-controlname`) as stable locators, waiting for
the "Please wait" overlay, and the controls the app has learned in `knowledge/pages.json`.

The skill folder holds two files: `SKILL.md` (the instructions) and `cli.config.json` (the playwright-cli config the
skill's setup step copies to `.playwright/cli.config.json`).

Install it where your agent looks for skills:

```bash
# Claude Code, for this project (or ~/.claude/skills for every project)
mkdir -p .claude/skills && cp -r skills/d365fo-playwright-cli .claude/skills/
# GitHub Copilot in VS Code
mkdir -p .github/skills && cp -r skills/d365fo-playwright-cli .github/skills/
```

Then ask, for example, *"Run examples/testcases/vendor-create.json against my sandbox with playwright-cli"*.
The skill's setup section installs playwright-cli and its F&O config.

The skill works without the rest of this app. With it, the agent can also use `d365fo-agent session-login` (save an F&O
sign-in to reuse), the learned pages in `knowledge/pages.json` (written by the app's runs; the folder is `KB_DIR` and
is not committed), and `d365fo-agent export-tests` (write the app's recorded passing runs as Playwright tests).
