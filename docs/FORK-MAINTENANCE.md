# Maintaining the Live TV fork

The custom feature is on `feature/live-tv-view`. Its viewer code lives in
`server/assets/ui/liveview.js`, its fixed-target WebSocket proxy in
`server/lib/vncproxy.js`, and noVNC 1.6.0 in `server/assets/novnc/`. The vendored
noVNC sources are unchanged. Small integration changes register the tab,
serve its authenticated API, attach the upgrade handler and deploy its files.

## Connect the fork

After creating a fork on GitHub, make `origin` point to that fork and retain
the official repository as `upstream`. Replace `YOUR-ACCOUNT` below.

```sh
git remote set-url origin https://github.com/YOUR-ACCOUNT/glasshouse.git
git remote add upstream https://github.com/rorygallagher2024/glasshouse.git
git push -u origin feature/live-tv-view
```

If `upstream` already exists, inspect `git remote -v` instead of adding it again.

## Bring in official updates

Start with a clean working tree. Merge preserves both the customization and
upstream history without rewriting published commits:

```sh
git fetch upstream
git switch feature/live-tv-view
git merge upstream/main
```

Resolve any conflicts and run the checks in `CLAUDE.md` before pushing. Changes
to the existing routes, sidebar, UI assembly or deployment file list can need
manual reconciliation. The separate viewer and proxy modules normally do not
overlap with upstream edits. Local config files are ignored by Git and should
remain private.

After validation, push the merged branch to the fork and deploy it from Git
Bash on the PC:

```sh
git push origin feature/live-tv-view
cd server
./deploy.sh TV-IP
```

The TV's config is retained by deployment, including the dashboard token and
`remoteDesktop` settings. Test connection, mouse/keyboard input, leaving the
Live TV tab, and reconnecting on the TV after an update.

## Built-in updates

Glasshouse's built-in updater still downloads releases from the official
repository. It does not merge Git branches or preserve this customization.
Use the merge-and-deploy procedure above for this installation. One-click
updates from a fork require a separate change to the release source and a
tested release workflow in that fork; that has not been implemented.

Installing an official release can replace the integration. Redeploying this
custom branch restores its code. The installer also keeps its previous server
copy for rollback, as documented in `managing.md`.
