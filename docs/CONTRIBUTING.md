# Contributing to Glasshouse

Contributions are welcome. This guide outlines how to propose changes, write compatible code, and review pull requests.

## Core principles

* **You own the glass:** The project exists to give owners direct control over their TV without vendor lock-in, cloud dependencies, or tracking. No telemetry or analytics are collected.
* **Keep the TV lightweight:** The TV's onboard CPU and RAM are shared with video decoding and system processes. Code running on the TV must remain fast, lean, and free of unnecessary background work.
* **Zero runtime dependencies:** The on-TV server runs with no npm packages installed on the device.

## Working conventions

### Never push to main

Always work on a branch and submit a pull request:

1. Create a branch from `main`.
2. Make changes, keeping commits focused and logically distinct.
3. Push the branch to your fork or the repository.
4. Open a pull request against `main`.

If a pull request needs follow-up adjustments, push additional commits to the existing branch rather than opening a new pull request for the same work.

### Commit messages and PR descriptions

Focus on clarity and readability. Clearly state what changed and why, keeping pull request descriptions concise and focused on the context reviewers need.

If you are using AI coding assistants or automated agents, ensure they adhere to the repository conventions in `CLAUDE.md` (symlinked as `AGENTS.md`).

### Multiple agents and worktrees

Give each agent its own branch, worktree, emulator container or VM, and local
emulator port. Worktrees
isolate source files, dependencies and build output; they do not isolate the
physical TV. Deploying another branch replaces the installation all agents
would be testing, and power, inputs, settings and Home state are shared.

From the Glasshouse Git repository root, create two worktrees from the agreed
base commit (here, local `main`):

```bash
git worktree add -b agent/dashboard ../glasshouse-dashboard main
git worktree add -b agent/controls ../glasshouse-controls main
```

Worktrees contain committed files from that base. Uncommitted changes in the
original checkout are not included. To build on another branch, use its name
instead of `main`. Assign one worktree to each agent and have it read that
worktree's `AGENTS.md` before editing. Run `npm ci` separately in each worktree;
do not share `node_modules` or generated output between them.

In separate terminals, start an emulator from each worktree using the
[container instructions](development/testing.md#parallel-emulator-instances).
These Bash commands assume Docker with Linux containers is available; on
Windows, run them in WSL with Docker integration enabled:

```bash
# Dashboard agent
cd ../glasshouse-dashboard
npm ci
docker run --rm --init -it --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  --workdir /workspace --publish 127.0.0.1:18081:18081 \
  node:24-bookworm node scripts/emulate-tv.js --port 18081 --model c2
```

```bash
# Controls agent
cd ../glasshouse-controls
npm ci
docker run --rm --init -it --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,src=$(pwd),dst=/workspace,readonly" \
  --workdir /workspace --publish 127.0.0.1:18082:18082 \
  node:24-bookworm node scripts/emulate-tv.js --port 18082 --model b8
```

Each terminal starts at the original repository root. Open
`http://localhost:18081/` or `http://localhost:18082/`, using the port printed
by that emulator. Use a separate browser profile or browser context per agent
to keep browser storage and sessions apart. See
[Local TV emulation](development/testing.md#local-tv-emulation) for the other
views and limits. Run tests and checks from the agent's own worktree.

#### Sharing the real TV

Choose one coordinator to assign exclusive TV access. An agent without that
assignment uses local emulation and fixtures. This is a coordination rule;
the deployment and TV tools do not currently enforce a lock.

1. Before any TV access, record the owner, TV address, worktree, branch,
   commit and intended checks in the shared task or handoff message. Only
   that owner uses the TV until the handoff, including diagnostic reads that
   might otherwise observe a changing installation.
2. The owner records the current installed version and relevant settings,
   then checks the deployment worktree with `git status --porcelain
   --untracked-files=all`. It must print nothing. Record `git rev-parse HEAD`
   and `git rev-parse --short HEAD`, and keep that worktree unchanged through
   deployment and testing. `deploy.sh` copies working-tree files and permits
   dirty builds; a commit ID alone does not identify those files. Keep a
   known good commit available for recovery. No other agent deploys, restarts,
   changes settings or runs TV checks during this interval.
3. Deploy from that clean worktree. Read `/var/lib/tvweb/build.json` on the
   TV and confirm its `commit` matches the recorded short ID, `dirty` is
   `false`, and its `version` matches the candidate. Confirm the running
   dashboard reports that build after restart. Record both the full local
   commit ID and the installed metadata. Missing or mismatched metadata, a
   dirty build or a failed restart must be resolved before recording results
   against that commit. Check the worktree is still clean after deployment.
4. Record the model, webOS version, tested commit, actions and observed
   results. Restore settings changed only for the test, and leave the TV on
   an explicitly recorded build with its remaining state described.
5. Release access explicitly. A subsequent owner deploys its own candidate
   before testing; it must not assume the preceding branch is still installed.
   If an owner stops responding, the coordinator confirms no TV commands
   remain active and records a takeover before another agent uses it.

Local checks can run concurrently with another agent's TV checks. Emulator
results do not replace hardware validation: a PR not tried on a real TV stays
a draft, with the local results and missing hardware checks recorded in its
Testing section.

## Code reviews

We prefer code review comments to follow the [Conventional Comments](https://conventionalcomments.org/) standard (e.g. `praise:`, `suggestion:`, `issue:`, `nitpick:`, `question:`). This keeps feedback constructive, actionable, and makes it clear whether a comment is blocking or an optional suggestion. Refer to [conventionalcomments.org](https://conventionalcomments.org/) for the complete specification and examples.

## Environment and compatibility

### Strict ES5 for on-TV code

The server runs on the TV under Node.js 0.12 on webOS 3 and 4, and 0.10 on webOS 2. All files executing on the TV must remain strict ES5:

* `server/tvweb.js`
* `server/lib/*.js`
* `server/assets/dashboard.html`
* `server/assets/setup.html`
* `server/assets/setup-phone.html`
* `server/assets/home.html`
* `server/assets/home-app/index.html`

Avoid all ES6+ constructs in these files: no `const` or `let`, arrow functions, template literals, classes, default parameters, destructuring, promises, `async`/`await`, `for...of`, or ES6 built-in methods (`Object.assign`, `Array.prototype.find`, etc.).

Run `python3 scripts/check-es5.py` to verify compliance.

### Modern JavaScript in browser dashboards

Modern JavaScript (ES6+) is permitted exclusively in client-side code running in modern desktop/mobile browsers:

* `server/assets/ui.html`
* `server/assets/ui/*.js`

### Adding new server assets

The deploy script (`server/deploy.sh`) maintains an explicit list of files copied to the TV via SSH (`FILES`). Any new module or asset in `server/` required by the TV must be added to this list. `scripts/check-drift.py` verifies that all files on disk match the deploy manifest.

### Localized strings

All user-visible text on the dashboards is keyed for localization:

* In HTML: `data-t="section.key"`
* In JavaScript: `t('section.key', 'Default English string', { vars })`

Strings are cataloged in `server/assets/i18n/`. Refer to [Translating the dashboards](STRINGS.md) for full formatting rules. Run `python3 scripts/check-strings.py` to ensure all strings are keyed and translated without drift.

## Running tests and verification

Before opening a pull request, run the test suite and validation scripts locally:

`scripts/check-all.sh` runs all of these side by side. One at a time:

```bash
# Run all unit and integration tests
node test/run-all.js

# Type checking
npx tsc

# Syntax and architecture checks
python3 scripts/check-es5.py
python3 scripts/check-drift.py
python3 scripts/check-strings.py
python3 scripts/check-ui-ids.py
python3 scripts/check-screensavers.py
python3 scripts/check-module-calls.py
python3 scripts/check-entity-stability.py
python3 scripts/check-entities.py --stats test/fixtures/stats-b8-webos4.json

# The release's updater can still install the change on TVs already out there
node scripts/check-upgrade.js
```

All automated checks must pass cleanly.

### Previewing UI changes locally

To visually preview and interact with the web dashboard, TV app, or Glasshouse
Home without a physical TV, first follow the
[container or VM setup](#multiple-agents-and-worktrees). Run these commands
inside that isolated environment; the mock runner can execute host commands:

```bash
npm run emulate
```

This starts the server against a virtual webOS environment with procfs, sysfs, Luna bus calls, apps, remote keys, and recent apps mocked. You can also specify a model or port:

```bash
node scripts/emulate-tv.js [--model c2|b8|c3|cx|c1] [--webos 6.5.3] [--home on|off] [--port 8080] [--open]
```

Direct URLs:
* Web Dashboard: `http://localhost:8080/`
* TV App Dashboard: `http://localhost:8080/assets/dashboard.html`
* Glasshouse Home: `http://localhost:8080/assets/home.html`

### Previewing documentation locally

The documentation site is built with [MkDocs](https://www.mkdocs.org/) and the [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) theme. To preview documentation changes locally with live reloading:

```bash
python3 -m venv .venv
.venv/bin/pip install 'mkdocs>=1.6,<2' 'mkdocs-material>=9.7,<10' 'markdown-callouts>=0.4,<0.5'
NO_MKDOCS_2_WARNING=1 .venv/bin/mkdocs serve
```

Then open `http://127.0.0.1:8000/glasshouse/` in a browser. The page reloads automatically whenever a file under `docs/` or `mkdocs.yml` is saved. (With Nix, `nix develop` provides these packages directly so `mkdocs serve` works without a virtual environment.)

To run the same strict build and link check that CI runs on pull requests:

```bash
NO_MKDOCS_2_WARNING=1 .venv/bin/mkdocs build
```

## Testing on a real TV

The automated checks run the server's code, not the TV. LG's services, the picture and sound pipeline and the start-up sequence behave differently between models and webOS versions, and only a real TV shows how a change behaves there. Before asking for a review:

* **Deploy the change to a rooted TV** with `server/deploy.sh <tv-ip>`, and use what it changes the way someone would: on the web dashboard, in the TV app, or from Home Assistant.
* **Check that what's around it still works.** The TV still shows its inputs, sound still plays, and the dashboard keeps updating.
* **Restart the server or the TV** if the change affects start-up, the boot hook (`server/50-tvweb.sh`), or anything that runs only once.
* **Mind older TVs.** On webOS 2 to 4 the server runs on Node 0.10 or 0.12, and a call newer firmware accepts may not exist there. If you can only test on one generation, say which.
* **Older TVs get fewer features, not a lower ceiling.** webOS 2 and 3 lack many of LG's services, so features that need them are left out there rather than held back everywhere: gate a feature on the TV's version or on the service answering. The oldest TVs set only one limit, that the server and the TV app stay ES5 for Node 0.10 and 0.12. Support for both goes together, once keeping it costs real development, such as wanting ES6 in the server.

### Testing details in the pull request

Add a short **Testing** section to the pull request description:

* the TV's model and webOS version, for example "OLED42C24LA, webOS 9.2";
* what you did and what you saw;
* what you didn't test, such as other webOS versions or something that needs hardware you don't have.

For example:

```
## Testing

- OLED42C24LA, webOS 9.2: hid and unhid three tiles from the Apps tab. Each took
  about 4 seconds, and HDMI 2 kept its picture and sound throughout.
- Not tested on webOS 4 or on webOS 10 and later.
```

### If you can't test on the right TV

If you don't have a TV to test on, or the change affects TVs you don't have, say so in the pull request and ask for testers. A maintainer will label it [testers wanted](https://github.com/rorygallagher2024/glasshouse/labels/testers%20wanted), where people with other TVs look for things to try.

### Help by testing on your TV

Some changes can only be checked on TVs the maintainers don't have, such as newer or less common models. If you have a rooted LG TV, you can help without writing any code: pull requests and issues labelled [testers wanted](https://github.com/rorygallagher2024/glasshouse/labels/testers%20wanted) say what to run and what to send back.
