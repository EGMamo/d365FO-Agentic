# Skills for coding agents

[`d365fo-playwright-cli`](d365fo-playwright-cli/SKILL.md) lets a coding agent (Claude Code, GitHub Copilot in VS Code,
and others that read `SKILL.md` skills) test D365 Finance & Operations through
[playwright-cli](https://github.com/microsoft/playwright-cli), with what this app knows about F&O: direct form links,
control names as stable locators, waiting for the "Please wait" overlay, and the controls learned in `knowledge/pages.json`.

Install it where your agent looks for skills:

```bash
# Claude Code, for this project (or ~/.claude/skills for every project)
mkdir -p .claude/skills && cp -r skills/d365fo-playwright-cli .claude/skills/
# GitHub Copilot in VS Code
mkdir -p .github/skills && cp -r skills/d365fo-playwright-cli .github/skills/
```

Then ask, for example, *"Run examples/testcases/vendor-create.json against my sandbox with playwright-cli"*.
The skill's setup section installs playwright-cli and its F&O config.
