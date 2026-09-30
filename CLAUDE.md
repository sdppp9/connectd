# ConnectD — notes for Claude

Desktop DB client (Electron + React + TypeScript) for MySQL and PostgreSQL. See README.md.
The owner writes in Thai; reply in Thai.

## Every change that ships: bump the version and log it

1. Add an entry to `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed / Removed),
   written for users, not a list of files.
2. Bump the version with SemVer:
   - PATCH (1.1.0 → 1.1.1): bug fixes only
   - MINOR (1.1.0 → 1.2.0): new features, backwards compatible
   - MAJOR (1.x → 2.0.0): breaking changes (e.g. saved data or file formats that no longer load)
   Use `npm version <patch|minor|major> --no-git-tag-version` so package.json and
   package-lock.json stay in sync. Move the `[Unreleased]` notes under the new version heading
   with today's date and update the compare links at the bottom.
3. `npm run typecheck`, then `npm run dist:win` (the zip name carries the version).
4. Commit (`Release vX.Y.Z` for the version bump), tag `vX.Y.Z`, push with tags, and create a
   GitHub release: `gh release create vX.Y.Z release/ConnectD-X.Y.Z-win-x64.zip --notes-file <that version's changelog section>`.

Several small edits in one session are one release, not one version each.

## Checks
- The GitHub repo (sdppp9/connectd) is **public**: never commit credentials, real hostnames,
  database dumps or test data from the owner's databases.
- `npm run typecheck` must pass.
- Databases the owner connects to include production: destructive operations must show the
  exact SQL and require typed confirmation.
