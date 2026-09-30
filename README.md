# ConnectD

Desktop database client for **MySQL / MariaDB** and **PostgreSQL**, built with
Electron + React + TypeScript.

## Download & install (Windows 10/11, 64-bit)

1. Open the [latest release](https://github.com/sdppp9/connectd/releases/latest) and download
   `ConnectD-<version>-win-x64.zip` under **Assets**.
2. Right-click the zip → **Properties** → tick **Unblock** → **OK**.
3. Right-click → **Extract All…** to a permanent folder, e.g. `C:\Apps\ConnectD`.
4. Run `ConnectD.exe`. No installer and no admin rights needed.
5. Windows may show **"Windows protected your PC"** the first time because the app is not
   code-signed. Click **More info → Run anyway**.

**Update:** download the new zip and extract it over the old folder (or to a new one). Your
connections, history and settings live in `%APPDATA%\ConnectD`, not in the app folder, so they
are kept.

**Uninstall:** delete the app folder. To also remove saved connections and history, delete
`%APPDATA%\ConnectD`.

## Quick start

1. Click **+** in the sidebar → enter host, port, user, password (and optionally a database) →
   **Test** → **Save**.
2. Click the connection to connect. Tables and columns appear in the sidebar.
3. Type SQL in the editor (autocomplete suggests tables and columns) and press
   **Ctrl + Enter** or **Run**. Highlight part of the script to run only that part.
4. Double-click a cell in the result to edit it, then **Save changes**.
5. **Compare & Sync** and **Backup** are in the top bar. Back up before syncing to production.
6. Moving to another PC: use **Export connections** in the sidebar header, then
   **Import connections** on the other machine.

<details>
<summary>วิธีติดตั้ง (ภาษาไทย)</summary>

1. เข้า [หน้า Release ล่าสุด](https://github.com/sdppp9/connectd/releases/latest) แล้วโหลด
   `ConnectD-<version>-win-x64.zip` ในหัวข้อ **Assets**
2. คลิกขวาไฟล์ zip → **Properties** → ติ๊ก **Unblock** → **OK**
3. คลิกขวา → **Extract All…** ไปไว้ในโฟลเดอร์ถาวร เช่น `C:\Apps\ConnectD`
4. เปิด `ConnectD.exe` ได้เลย ไม่ต้องติดตั้ง ไม่ต้องใช้สิทธิ์ admin
5. ถ้าขึ้น **"Windows protected your PC"** ให้กด **More info → Run anyway**
   (ขึ้นเพราะโปรแกรมยังไม่ได้เซ็นชื่อผู้พัฒนา ไม่ใช่ไวรัส)

**อัปเดต:** โหลด zip ใหม่แล้วแตกทับโฟลเดอร์เดิม connection, history และการตั้งค่าเก็บอยู่ใน
`%APPDATA%\ConnectD` จึงไม่หาย

**ใช้งาน:** กด **+** เพิ่ม connection → **Test** → **Save** → คลิกเพื่อเชื่อมต่อ → พิมพ์ SQL แล้วกด
**Ctrl + Enter** · ดับเบิลคลิกช่องในตารางผลลัพธ์เพื่อแก้ไข แล้วกด **Save changes** ·
ปุ่ม **Compare & Sync** และ **Backup** อยู่แถบด้านบน

</details>

## Features

- **Saved connections** — store host / port / user / password / database. Passwords are
  encrypted with the OS keychain (Electron `safeStorage`, Windows DPAPI) and never written
  as plain text.
- **Export / import connections** — move saved connections to another machine as a `.json`
  file. Passwords are left out unless you set a passphrase, which encrypts them
  (scrypt + AES-256-GCM); the importer needs the same passphrase. Import previews the file,
  flags connections that are already saved (same server, user and database) and lets you
  skip, replace or copy them.
- **SQL editor with autocomplete** — CodeMirror 6 suggests SQL keywords plus real
  database / table / column names introspected from the live connection. **Tab** or
  **Enter** accepts a suggestion. Highlight part of the script and **Run selected**
  (or Ctrl/Cmd + Enter) runs only that part. Ctrl + mouse wheel changes the editor font
  size; drag the bar under the editor to resize it (double-click resets). Both are remembered.
- **Schema tree** — browse databases → tables → columns; double-click a table or click a
  column to insert its name into the editor.
- **Result grid** — filter, sortable columns, row count and execution time; `NULL` shown
  distinctly. Duplicate column names from joins are kept apart (`o.id`, `c.id`).
- **Inline editing, including joins** — the server reports which table and column every
  result column comes from; each source table whose full primary key is in the result is
  editable (double-click a cell). **Save changes** writes parameterized `UPDATE`s for all
  touched tables in one transaction, after a confirmation. Computed columns, aggregates,
  `UNION`s and tables whose key isn't selected stay read-only (marked with a lock). In a
  LEFT JOIN, cells of a row with no match can't be edited. PostgreSQL self-joins are
  read-only (the server can't tell the two references apart).
- **Export** — CSV, JSON, or Excel (`.xlsx`).
- **Query history** — every run is logged; click an entry to reload the SQL.
- **Compare & sync schema** — diff two databases (e.g. dev → prod): tables, columns, indexes
  and foreign keys. Generates the DDL to make the destination match the source; destructive
  statements are opt-in, the exact SQL is shown before running, and the destination can be
  backed up automatically first.
- **Backup & restore** — dump a whole database (structure + data, or structure only) to
  `.sql` / `.sql.gz` from a consistent snapshot, streamed so large tables don't fill memory.
  Restore into a new database or over an existing one (typed confirmation + optional safety
  backup of the target). PostgreSQL restores can run in one transaction. Also restores
  `mysqldump` files and `pg_dump --inserts` files. Auto backups go to
  `Documents\ConnectD Backups`.
  Not included: users/grants, events (MySQL), RLS policies and custom non-enum types (PostgreSQL).
- **Modern UI** — Tailwind CSS, dark mode by default (toggle to light), Lucide icons.

## Architecture

- **Main process** (`src/main`) owns all database access: connection pooling, query
  execution, schema introspection, encrypted credential storage, history, and file export.
- **Preload** (`src/preload`) exposes a typed, minimal API over `contextBridge`.
- **Renderer** (`src/renderer`) is the React UI. `contextIsolation` is on and
  `nodeIntegration` is off — the renderer has no direct DB access.

## Development

```bash
npm install
npm run dev        # launch the app with HMR
npm run typecheck  # type-check main + renderer
npm run build      # production bundle into out/
```

> On first `npm install` in a sandboxed environment, the `electron` and `esbuild`
> post-install scripts may be blocked. Approve them with
> `npm approve-scripts electron esbuild` and re-run if needed.

## Packaging for Windows

```bash
npm run dist:win
```

This produces a single artifact in `release/`:

- **`ConnectD-<version>-win-x64.zip`** — the whole app folder, zipped. Recipients **unzip it
  and run `ConnectD.exe`** inside. No installation needed.

`npm run dist:dir` produces the same app as an unzipped `release/win-unpacked/` folder.

### Why zip and not an installer / portable .exe?

The build is **not code-signed**, and unsigned NSIS installers / self-extracting portable
`.exe`s are frequently flagged by Windows Defender and other antivirus as suspicious
(false positive), which can quarantine the file so it won't launch. A plain zipped app
folder (a normal Electron `.exe`, like VS Code) triggers this far less. Windows SmartScreen
may still warn on first launch — click **More info → Run anyway**.

To remove the warning entirely you need a **code-signing certificate** (OV or EV); with one,
electron-builder can sign automatically.

> **Signing-tool note:** `CSC_IDENTITY_AUTO_DISCOVERY=false` (already set in the `dist:*`
> scripts via `cross-env`) stops electron-builder from probing the Windows cert store, which
> avoids downloading the `winCodeSign` bundle whose macOS symlinks fail to extract without
> Developer Mode.

## Notes

- Inline update targets rows by their primary key using `<=>` (MySQL) /
  `IS NOT DISTINCT FROM` (PostgreSQL) for null-safe matching.
- Numeric/`BIGINT`/`DECIMAL`/`NUMERIC` values are returned as strings to avoid precision
  loss.

## Versioning

Versions follow [SemVer](https://semver.org/); every release is listed in
[CHANGELOG.md](CHANGELOG.md) and published as a GitHub release with the Windows zip attached.
