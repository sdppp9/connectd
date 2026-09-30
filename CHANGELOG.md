# Changelog

All notable changes to ConnectD are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH).

## [Unreleased]

## [1.2.0] - 2026-09-30

### Added
- Click a row in the result grid to highlight the whole record, so it stays easy to follow
  while scrolling left and right through many columns. Click it again (or press Esc) to clear.
  With the grid focused, ↑ / ↓ move the highlight and scroll it into view. The highlight
  follows the record when you sort or filter.

## [1.1.0] - 2026-09-30

### Added
- Export / import saved connections as a `.json` file, from the Connections header.
  - Passwords are left out unless a passphrase is set; with one they are encrypted
    (scrypt + AES-256-GCM) and the importer needs the same passphrase.
  - Import shows a preview, marks connections that are already saved (same server, user and
    database) and lets you skip, replace or add them as a copy.

## 1.0.0 - 2026-09-30

First release.

### Added
- Saved MySQL / MariaDB and PostgreSQL connections, passwords encrypted with the OS keychain.
- Multiple query tabs, restored on restart.
- SQL editor with schema-aware autocomplete (Tab or Enter accepts), Run selected,
  Ctrl + mouse wheel font size and a resizable editor pane.
- Schema tree with view data and table structure editing.
- Result grid with filter and sort; duplicate column names from joins kept apart.
- Inline editing of query results, including joins (one transaction per save).
- Export results to CSV, JSON and Excel.
- Query history and saved queries.
- Compare & sync schema between two databases (tables, columns, indexes, foreign keys),
  with an optional automatic backup before applying.
- Full database backup (`.sql` / `.sql.gz`) and restore, including `mysqldump` and
  `pg_dump --inserts` files.
- Windows build as a zip (unzip and run `ConnectD.exe`).

[Unreleased]: https://github.com/sdppp9/connectd/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/sdppp9/connectd/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/sdppp9/connectd/releases/tag/v1.1.0
