# Database4every1

Database4every1 is a cross-platform desktop database workspace built with
[Tauri 2](https://tauri.app/), Rust, React, TypeScript, Vite, and Tailwind CSS.
It provides one DataGrip-inspired interface for exploring, querying, editing,
importing, and exporting data across SQL and NoSQL systems.

The application runs the interface inside the operating system WebView while
all connections, queries, schema discovery, SSH tunnels, and local persistence
are handled by the Rust backend.

## Features

### Supported database engines

| Engine | Connection and schema explorer | Query execution | Grid editing |
| --- | --- | --- | --- |
| PostgreSQL | Yes, including discovery of every accessible database when no database is specified | Dynamic SQL through `sqlx` | Insert, update, and delete |
| MySQL | Yes, including all permitted schemas when no database is specified | Dynamic SQL through `sqlx` | Insert, update, and delete |
| MongoDB | Collections and fields inferred from sampled documents | Mongo shell-style `find`, `insertOne`, `updateOne`, and `deleteOne` | Insert, update, and delete |
| Elasticsearch | Indices and flattened mapping fields | REST Query DSL, SQL API, indexing, update, and delete requests | Insert, update, and delete |
| Redis | Accessible logical databases, key types, and prefix groups | Raw Redis commands and automatic key inspection | Read-only grid |

SQLite is visible as a future connection option in the UI, but its Rust driver
is not currently registered. Attempting to connect returns an unsupported
database error instead of silently behaving incorrectly.

### Data Sources explorer

- Create, edit, test, reconnect, refresh, and delete saved connections.
- Duplicate a connection into a prefilled new-connection form without changing
  the original.
- Connect by selecting a data source; its schema is loaded automatically.
- Browse databases, schemas, tables, views, collections, indices, Redis logical
  databases, key-prefix groups, and columns/fields.
- Open a table, collection, index, or Redis key in its own static query tab.
- Generate and execute an engine-specific preview query automatically.
- Refresh schema metadata manually per connection.
- Sort explorer objects alphabetically.
- Import records from the context menu of SQL tables and Elasticsearch indices.
- Use engine-specific icons for connections.

### Connection groups and environments

Connections can be organized into collapsible, colored groups such as
Production, Staging, or Local Development.

- Drag connections into a group or back to the ungrouped area.
- Choose a group color and Lucide icon.
- Rename, edit, duplicate, or delete a group.
- Delete a group while keeping its connections, or remove both.
- Duplicate a group together with all its connections.
- Group colors are reflected in query tabs.
- Define any number of group variables and use them in connection settings with
  `{{variable_name}}`, for example `{{host}}`, `{{port}}`, or
  `{{es_password}}`.
- Duplicated groups receive independent variables and connection copies.

Variables are resolved immediately before connecting, so the saved connection
can remain reusable between environments.

### Connection configuration

The connection form supports:

- Engine, group, host, port, database, username, password, and SSL mode.
- Connection testing before saving.
- PostgreSQL/MySQL connections without a database name to discover all
  databases the user is allowed to access.
- Passwordless Redis connections.
- Elasticsearch TLS certificate verification bypass for self-signed development
  clusters. This option is intentionally marked as insecure.
- Editing and deletion from both the connection modal and explorer context menu.

### SSH tunnels

Database traffic can be routed through an SSH jump host.

- Password or private-key authentication.
- Encrypted private-key passphrases.
- Configurable SSH connection timeout.
- Local TCP forwarding to the target database host and port.
- Host-key verification against `~/.ssh/known_hosts`.
- Trust-on-first-use confirmation showing the received fingerprint before a new
  host key is added automatically.
- SSH support for PostgreSQL, MySQL, MongoDB, Elasticsearch, and Redis.

Release builds use vendored OpenSSL for `libssh2`, preventing packaged macOS
applications from depending on a developer machine's Homebrew installation.

### Query workspace

- Dockable, multi-tab query interface powered by Dockview.
- Every tab owns a fixed connection, query, result, limit, page, and sort state;
  selecting another data source does not mutate existing tabs.
- Tab labels include group, connection, and opened object information.
- Middle-click closes a tab.
- Monaco SQL and JSON editors with independent models per tab.
- Schema-aware SQL completion for table and field names.
- Run queries with the toolbar or `Cmd/Ctrl + Enter`.
- Cancel an active query from the UI.
- Per-tab row limits: 50, 100, 200, 500, or 1,000.
- Typed backend errors and live execution log events.

#### Query formats

PostgreSQL and MySQL accept SQL. PostgreSQL preview tabs include an internal
database directive when the connection is browsing multiple databases.

MongoDB accepts shell-like queries such as:

```javascript
db.assets.find({ status: "active" }).sort({ created_at: -1 }).skip(0).limit(200)
```

Elasticsearch accepts SQL or REST-style Query DSL:

```text
POST /assets/_search
{
  "size": 200,
  "query": {
    "match_all": {}
  }
}
```

Redis accepts raw commands such as `GET`, `HGETALL`, `XRANGE`, and `SCAN`.
Explorer previews use the internal `DUMPVALUE [DB n] key` command to select the
correct Redis operation for a key type. Stream entries are normalized into an
Entry ID column and individual field columns.

### Server-side limits, sorting, and pagination

The current limit, sort, and page are written back into the tab's visible query
before execution:

- SQL: `ORDER BY`, `LIMIT`, and `OFFSET`.
- MongoDB: `.sort()`, `.skip()`, and `.limit()`.
- Elasticsearch: `sort`, `from`, and `size` in the JSON body.
- Header sorting cycles through ascending, descending, and cleared.
- First, Previous, Next, and Last controls use server-side pagination.
- Total-record counts and the displayed range are shown in the result bar.
- Column order remains stable across sorting and page changes, even when
  schemaless records contain different fields.

Elasticsearch searches use Point in Time (PIT) and `search_after` internally,
so deep pages do not fail at the default result-window boundary. Nested mapping
paths are detected automatically and the required nested sort context is added
without discarding user-provided query options.

### Result grid

Results are rendered with Glide Data Grid, a canvas-based virtualized grid
designed for large result sets.

- Virtualized vertical and horizontal scrolling.
- Explicit resizable column widths.
- Stable dynamic columns for JSON/BSON documents.
- Copy selected cells as CSV or JSON.
- Web Clipboard API with a native Tauri clipboard fallback.
- Right-click any cell to inspect its value, edit the cell, or stage row
  deletion where supported.
- Double-click editable cells to open the cell editor.
- Value Inspector side panel for formatted nested JSON/BSON values.
- Separate Results and Output tabs.
- Output includes status, execution time, affected rows, returned rows,
  warnings, notices, cancellation messages, and errors.

### Data editing and commits

Explorer-backed PostgreSQL/MySQL tables and MongoDB/Elasticsearch collections
or indices support staged changes.

- Add a row from the grid's trailing row.
- Edit a cell by double-clicking or using its context menu.
- Stage a row for deletion from the context menu or row selection.
- Review the pending-change count before writing anything.
- Commit with the bottom action button or `Cmd/Ctrl + S`.
- Discard every staged insertion, update, and deletion with Cancel or `Escape`.
- Refresh the query after a successful commit.

SQL changes are committed as a transaction. MongoDB changes target `_id`, and
Elasticsearch changes target the hit `_id`. Elasticsearch dotted fields are
rebuilt as nested objects before updates.

### Import and export

Import is available for SQL tables and Elasticsearch indices:

- CSV
- JSON
- XML
- XLS/XLSX

SQL records are inserted in batches; Elasticsearch records are indexed through
the REST executor.

The result exporter loads the complete server-side result rather than only the
visible page. Users can select all fields or a subset and save as:

- CSV
- JSON
- XML
- Excel (`.xlsx`)
- PDF

### Persistence and cleanup

Groups and connections are persisted as `connections.json` in Tauri's
platform-specific application configuration directory.

- Writes use a temporary file followed by an atomic rename.
- On Unix, the file is restricted to mode `0600`.
- An initialized workspace may intentionally contain zero connections; deleted
  examples are not seeded again.
- Deleting a connection closes its active driver, invalidates its schema cache,
  removes it from memory, and rewrites the persisted workspace.
- Open tabs tied to a deleted active connection are closed after confirmation.

Connection passwords and group variables are stored in this protected JSON
file, but they are not currently encrypted with the operating-system keychain.
Treat the local user account and configuration file as sensitive.

## Architecture

```text
React / TypeScript UI
  ├─ Data Sources explorer and connection forms
  ├─ Dockview query tabs and Monaco editors
  ├─ Glide virtualized result grids
  └─ Tauri IPC service layer
                 │
                 ▼
Rust / Tauri backend
  ├─ Typed commands and JSON errors
  ├─ ConnectionManager: Arc<RwLock<HashMap<...>>>
  ├─ Query cancellation registry and schema cache
  ├─ SSH tunnel and known-host verification
  ├─ Persistent workspace storage
  └─ DatabaseDriver implementations
       ├─ sqlx: PostgreSQL and MySQL
       ├─ mongodb
       ├─ elasticsearch
       └─ redis
```

Every database implementation conforms to the object-safe asynchronous
`DatabaseDriver` trait:

```rust
async fn connect(&self, config: &ConnectionConfig) -> Result<(), DbError>;
async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError>;
async fn fetch_schema(&self) -> Result<SchemaTree, DbError>;
async fn test_connection(&self) -> Result<bool, DbError>;
```

The frontend communicates through these main Tauri commands:

- `connect_db`
- `run_query`
- `cancel_query`
- `get_schema_tree`
- `refresh_schema_cache`
- `disconnect_db`
- `delete_connection`
- `load_connection_workspace`
- `save_connection_workspace`
- `save_export_file`

Errors cross IPC as typed JSON objects with a stable error code, human-readable
message, and optional structured details such as an unknown SSH fingerprint.

## Project structure

```text
.
├── src/
│   ├── components/
│   │   ├── connections/    # Engine-specific connection fields
│   │   ├── editor/         # Monaco query editor
│   │   ├── inspector/      # Value Inspector
│   │   ├── results/        # Grid, output, pagination, and export
│   │   ├── sidebar/        # Groups and connection tree
│   │   └── tabs/           # Dockview tab renderer
│   ├── services/           # Typed Tauri IPC wrappers
│   ├── types/              # Shared frontend models
│   └── utils/              # Query builders, mutations, clipboard, variables
├── src-tauri/
│   ├── src/db/
│   │   ├── commands.rs     # Tauri database commands and cancellation
│   │   ├── postgres.rs
│   │   ├── mysql.rs
│   │   ├── mongodb.rs
│   │   ├── elasticsearch.rs
│   │   ├── redis.rs
│   │   └── ssh_tunnel.rs
│   ├── src/storage.rs      # Atomic local workspace persistence
│   └── tauri.conf.json
└── .github/workflows/
    └── release.yml         # Release Please and installer builds
```

## Development

### Prerequisites

- Node.js 22 or newer
- npm
- Stable Rust toolchain
- Platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Recommended VS Code extensions:

- Tauri
- rust-analyzer
- ESLint

### Install and run

```sh
npm ci
npm run tauri dev
```

Run only the browser frontend:

```sh
npm run dev
```

### Validation

```sh
npx tsc --noEmit
npm run build
cd src-tauri && cargo check
```

## Building installers

### macOS Apple Silicon DMG

```sh
APPLE_SIGNING_IDENTITY=- npm run tauri build -- \
  --target aarch64-apple-darwin --bundles dmg
```

The local command uses ad-hoc signing. Public distribution requires a paid
Apple Developer account, a Developer ID Application certificate, and Apple
notarization. See [.github/APPLE_SIGNING.md](.github/APPLE_SIGNING.md).

### Windows

```sh
npm run installer:windows
npm run installer:windows:msi
```

NSIS output is written under `src-tauri/target/release/bundle/nsis/`; MSI output
is written under `src-tauri/target/release/bundle/msi/`.

### Linux

```sh
npm run tauri build -- --bundles appimage,deb,rpm
```

Linux requires WebKitGTK 4.1 and the other native packages listed in the release
workflow.

## Releases

The project uses Release Please and Conventional Commits:

- `fix: description` creates a patch release.
- `feat: description` creates a minor release.
- `feat!: description` or a `BREAKING CHANGE` footer creates a major release.

After the Release Please PR is merged, GitHub Actions creates the release and
builds the configured installers. Linux and Windows generation are currently
enabled. macOS entries are intentionally commented out until Apple signing and
notarization are configured.

## Security notes

- Do not use Elasticsearch `dangerously_ignore_tls` against production systems.
- Confirm SSH fingerprints through an independent trusted channel before adding
  a host key.
- Review generated mutations before committing grid changes.
- Query cancellation stops result processing, but database-side cancellation
  semantics depend on the driver and server.
- Public macOS downloads must be Developer ID signed and notarized.
