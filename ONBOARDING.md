# Fresh-machine onboarding

This is the canonical bootstrap entry point for a new workstation or a fresh coding-agent environment. Complete this document before implementation work. The objective is a reproducible machine that can build, test, inspect, and operate this repository without rediscovering tooling mid-campaign.

## 1. Preflight rule

1. Clone the repository and enter its root.
2. Confirm the intended repository/branch and fetch current `origin/main`.
3. Read the repository control-plane documents before changing code: `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `.agent/`, `docs/TASK_BOARD.md`, `docs/ARCHITECTURE.md`.
4. Install/verify the machine prerequisites below.
5. Enable the committed agent integrations and repository-local skills.
6. Restore dependencies from lockfiles/pins; do not casually upgrade them during bootstrap.
7. Run the baseline validation commands.
8. Only then begin a development campaign. If a prerequisite cannot be satisfied, record it as an environment blocker rather than weakening a gate.

Credentials, API keys, signing material, account logins, licensed models/assets, and other secrets are machine/user responsibilities. Never commit them.

## 2. Supported host and prerequisites

**Primary host:** Any desktop OS with Node.js >= 22 and a modern browser.

**Required machine tools**
- Git
- Node.js >= 22 + npm
- Python 3 for the simple static-server path
- Playwright Chromium for browser journeys

**Task-dependent / optional tools**
- No framework/build runtime is required to play; the Node toolchain is for validation and release assembly.


## 3. Agent setup

- Load repository instructions before acting. Prefer committed repository state over chat history.
- Repository-local skills: `goal`.
- Agent adapter/config directories present in this repository should be discovered and used in-place; do not duplicate them globally unless the harness cannot load repository-local configuration.
- Relevant committed agent surfaces: `.agent/`, `.agents/`, `.claude/`, `.kimi-code/`, `.opencode/`.
- MCP policy: No root `.mcp.json` is committed. Keep the development surface simple; only introduce an MCP when a concrete task requires it.
- Keep MCP/plugin authority narrow. Documentation/diagnostic MCPs are not permission to change architecture, bypass tests, or publish.
- Authentication for GitHub and coding-agent CLIs is configured separately on the machine. Never write tokens into tracked files.

## 4. Bootstrap

Run the repository's pinned bootstrap, not an improvised dependency upgrade:

```bash
npm ci
npx playwright install chromium
```

The shipped game is vanilla JavaScript/Canvas and can run over `file://`. Do not introduce a framework or asset pipeline as a bootstrap convenience.


## 5. Editor/LSP baseline

Use a JavaScript/TypeScript language service with ESLint-style static diagnostics if desired, but preserve the plain-script/global `window.TC` architecture and load-order contract in `AGENTS.md`.

The editor is optional; the language servers are not. Agents should have diagnostics/type information available before editing non-trivial code.

## 6. Baseline verification

```bash
npm run check
npm run check:i18n
npm test
npm run build
npm run verify:build
npm run test:browser
```

A fresh machine is considered **development-ready** only when the applicable non-external gates above pass. Hardware/device/signing/account gates may remain explicitly blocked if the repository already classifies them that way.

## 7. Fresh-agent instruction

Use this exact operating rule when handing the repository to a new agent:

> Read `ONBOARDING.md` first. Set up every applicable prerequisite, repository-local skill, MCP/plugin, dependency, browser/device/runtime tool, and validation gate described there. Then read the repository's durable agent state and only start implementation after preflight is green or a genuine environment blocker is recorded. Do not replace pinned tooling, skip gates, or invent work to compensate for a missing machine capability.
