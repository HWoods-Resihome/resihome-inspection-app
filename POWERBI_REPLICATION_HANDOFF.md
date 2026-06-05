# Power BI → Web Replication — Session Handoff

> **Purpose of this doc:** carry all context from the kickoff session into a new
> session that has the `HWoods-Resihome/ResiHome-Operations` repo connected.
> Read this top-to-bottom before doing anything; it records what's already been
> discovered so you don't repeat the Snowflake exploration.

_Last updated: 2026-06-05. Owner: hwoods@resihome.com_

---

## 1. The goal (owner's words, paraphrased)

There is a Power BI file (**"ResiHome Summary"**) that the whole company uses. It
pulls from **Snowflake** plus **a couple of other sources (Google Sheets,
SharePoint)**. We are replicating it as a **web app at a URL the team can access**.

Three phases, in order:

1. **Phase 1 — Faithful 1:1 replication** of the existing Power BI (data + every
   visual). _This is what we're on now._
2. **Phase 2 — Clean up & optimize the data sources / structure** so future
   changes are seamless.
3. **Phase 3 — Redesign** the dashboard to be more intuitive/user-friendly with
   new web-native features.

Long-term: this becomes a **landing page with 2FA auth** that the dashboard
embeds into.

## 2. Decisions already made (via owner Q&A)

| Decision | Choice |
|---|---|
| **Hosting** | **New standalone app/repo** (its own deploy, eventually 2FA landing page). Target home = `ResiHome-Operations` repo (pending connection — see §6). |
| **Data freshness** | **Hourly refresh** — cache Snowflake query results on a schedule (mirrors Power BI refresh; fast pages, low warehouse cost). |
| **First scope** | **One page first** — nail the main Summary page end-to-end as a proof-of-concept, then expand to the rest. |

## 3. Connected data sources / MCP tools available this session

Find these via `ToolSearch` (schemas are deferred). In the kickoff session they were:

- **Snowflake SQL** — an MCP `sql_exec` tool (execute a single SQL query).
  Confirmed working. Use `ToolSearch` query `sql exec` to load it.
- **Google Drive** — `search_files`, `read_file_content`, `download_file_content`
  (base64), `get_file_metadata`, `list_recent_files`. Use for pulling the
  Power BI project file if it's uploaded to Drive.
- **GitHub MCP** (`mcp__github__*`) — scoped per session (see §6).
- Also present but not needed: tldraw canvas, Gmail, Google Calendar.

> Note: MCP server IDs are session-specific. Don't hardcode them; rediscover via
> `ToolSearch` each session.

## 4. Snowflake — what we found (in-depth review, Phase 1 deliverable)

**Connection:** account `OTA12822`, Snowflake version `10.19.101`, role
`ANALYST`, warehouse `ANALYST_WH`. No default database/schema set (fully qualify
everything).

### Databases
- `PROD_ANALYTICS` ← **the analytics warehouse; everything we need is here**
- `PROD_REPLICA` (operational replica)
- `RESICAP_DATA` (mostly `SAGE_RESICAP`, 7 tables — accounting/Sage)
- `DOCUMENT_ANALYSIS_TEST`, `SNOWFLAKE`, `SNOWFLAKE_LEARNING_DB`,
  `SHARE_FINDIGS_RESICAP(_BACKUP)`, `USER$HWOODS` — not relevant to the report.

### `PROD_ANALYTICS` schemas (table counts)
```
DBT_RESICAP_STG (580)      raw / staging
DBT_RESICAP (174)          ← curated STAR SCHEMA (dim_/fct_)
DBT_RESICAP_BACKUP (107)
BI_MASTER_DATASETS (21)    ← materialized wide tables (BI backbone)
BI_DATASET_VIEWS (100)     ← THE POWER BI–FACING LAYER (subject-area views)
RESICAP (200)              additional curated objects
PUBLIC (23), DBT_RESICAP_SNAPSHOTS (7), TEST (1)
```

### Architecture (clean, layered — replication is tractable)
```
DBT_RESICAP_STG  →  DBT_RESICAP (star schema)  →  BI_MASTER_DATASETS / BI_DATASET_VIEWS
```
Business logic (joins, aggregations) already lives in Snowflake as **dbt models**.
The web app mostly needs to **query the BI views and render them**, like Power BI does.

### `BI_MASTER_DATASETS` (materialized tables w/ row counts)
- `MASTER_ASSET_MANAGEMENT` (102,779)
- `MASTER_MM_WORKORDER` (501,728)
- `MASTER_PM_COLLECTIONS` (2,625,299)
- `MASTER_PM_ACTIVE_LISTINGS` (652,323)
- `MASTER_PM_SUMMARY` (40,478) — **88-column property/unit rent-roll** (see below)
- `MASTER_UNDERWRITING_PROPERTIES` (78,965)
- `MASTER_MM_TURNKEY` (10,785), `MASTER_PM_RENEWAL_RELEASE` (36,531),
  `MASTER_PM_EVICTION` (11,303), `MASTER_CONSTRUCTION_WEEKLY_NOTES` (7,036)
- Plus views: `VW_MASTER_ACCOUNTING_GLDATA`, `VW_MASTER_CONSERVICE_*`,
  `VW_MASTER_CONSTRUCTION_*`, `VW_MASTER_PM_HAPPYCO`, `VW_MASTER_PM_TENANT`.

### `BI_DATASET_VIEWS` — 100 views, grouped by subject area
Maintenance/Work Orders (`VW_MAINTENANCE_WO_REPORT_*`, `VW_HUDSON_MAINTENANCES_*`,
`MAINTENANCE_ESTIMATES_*`, `VW_CLOSED_DETAIL_WO*`, `VW_MAINT_DEPARTMENT_SUMMARY_*`),
Construction (`VW_CONSTRUCTION_*`), Portfolio Performance
(`VW_PORTFOLIO_PERFORMANCE*`, `VW_BI_PORTFOLIO_PERFORMANCE*`),
**`VW_PORTFOLIO_SUMMARY_REPORT`**, Rent Roll (`VW_ALL_TENANT_RENT_ROLL`,
`VW_PORTFOLIO_RENTROLL_REPORT_*`), Tenant Ledger (`VW_TENANT_LEDGER_*`),
Vendor Summary (`VENDOR_SUMMARY__*`), Asset Mgmt (`VW_ASM_*`), Site Visits
(`VW_SITE_VISIT_REPORT*`), Acquisition (`VW_ACQUISITION_DILIGENCE_CLOSING`,
`VW_ASM_UNDERWRITING_PROPERTIES`), ResiAIMS (`VW_RESIAIMS_*`), leasing/move-in
(`VW_MOVE_IN_REPORT`, `VW_SIGNED_LEASE_RENEWAL`, `VW_PROPERTY_PRELEASING_*`).

### Verified example — `VW_PORTFOLIO_SUMMARY_REPORT`
dbt model `model.dbt_warehouse.vw_portfolio_summary_report`. Output columns:
`PORTFOLIO_NAME, "# of Properties", REGIONID, RENT, MAINTENANCECOST, INCOME,
EXPENSE, TOTALMARKETRENT, TOTALCONCESSION`, grouped by Portfolio × Region.
Source tables (all in `PROD_ANALYTICS.DBT_RESICAP`):
`fct_property_unit_summary`, `dim_portfolio`, `dim_region`, `dim_property_unit`,
`fct_leasing_transaction`, `fct_acc_payable_detail`, `dim_gl_account`.
Business rules seen: Active properties only (`HBPM_PROPERTY_STATE='Active'`,
`CURRENT_FLAG='Y'`), Rent = GL account `4010` charges, Maintenance =
`PAID_TO_TYPE_ID=504` payables, Concession = credit charges.

`MASTER_PM_SUMMARY` is a wide rent-roll grain (PropertyId/UnitId level) with 88
cols incl. Address, Region, PortfolioName, MarketRent/Rent/CurrentRent,
Tenant/lease dates, eviction status, DOM, leasing funnel metrics, etc.

## 5. Power BI file — STATUS: still need the real content

- Owner uploaded `9209a71e-ResiHome_Summary.pbip` but it's only the **188-byte
  pointer file**. It references the folder **`ResiHome Summary.Report`** (and there
  will be a sibling **`ResiHome Summary.SemanticModel`** folder).
- **We do NOT have** the actual report/model definition yet → cannot start
  replication of visuals/measures until we do.
- **We do NOT need the big `.pbix`** (it embeds cached data). We need the small
  **`.pbip` project text files** (TMDL/JSON).

### How to get the file in (owner was deciding between these)
- **Option A (preferred):** commit the `.pbip` project folder to
  `ResiHome-Operations`. Add `.gitignore` for `*.pbix`, `.pbi/`, `*.abf`,
  `localSettings.json`. Commit `ResiHome Summary.Report/` +
  `ResiHome Summary.SemanticModel/`.
- **Option B:** upload zipped folder to Google Drive; give the share link/ID;
  pull via the Drive MCP `download_file_content` + unzip.
- **Option C:** if only `.pbix` exists, re-save as `.pbip` in Power BI Desktop
  (File → Save as → Power BI project, or enable the preview feature).

What we actually need from inside it: the `definition/` (`.tmdl` / `model.bim`)
under **`.SemanticModel`** (tables, measures/DAX, relationships, **and the
Power Query/M source definitions** — these reveal which parts come from Snowflake
vs. Google Sheets vs. SharePoint), plus the page/visual files under **`.Report`**.

## 6. Repo scope — ACTION REQUIRED by owner

`HWoods-Resihome/ResiHome-Operations` exists (public, new, default branch `main`)
but the kickoff session could **not** access it:
> Access denied… Allowed repositories: hwoods-resihome/resihome-inspection-app

Claude can't add it from inside the session. **Owner must add
`HWoods-Resihome/ResiHome-Operations` to this environment's allowed repositories**
(Claude Code web/app → environment settings → repositories), then start the new
session. Docs: https://code.claude.com/docs/en/claude-code-on-the-web

Open question for the new session: confirm whether to **build the dashboard app
directly in `ResiHome-Operations`** (recommended, matches "standalone repo"
choice) vs. a subfolder of `resihome-inspection-app`.

## 7. Next steps (do these in the new session, in order)

1. **Confirm access**: `ResiHome-Operations` in scope? Snowflake `sql_exec` and
   Google Drive MCP loadable via `ToolSearch`?
2. **Ingest the `.pbip`** (whichever option owner used) and parse the
   **SemanticModel**: enumerate every table, measure (DAX), relationship, and
   **data source connection**. Produce a source map: which objects = Snowflake
   views (have access), which = Google Sheets / SharePoint (need separate access).
3. **Parse the Report**: list pages and, for the **main Summary page**, every
   visual + the fields/measures it binds to.
4. **Map Summary-page visuals → Snowflake views** (e.g. likely
   `VW_PORTFOLIO_SUMMARY_REPORT`, `VW_PORTFOLIO_PERFORMANCE*`) and reproduce DAX
   measures as SQL / app logic. Validate numbers against the live report.
5. **Flag Google Sheets / SharePoint dependencies** and tell owner exactly what
   access/exports are needed for those (these are the "couple other sources").
6. **Scaffold the standalone Next.js app** in `ResiHome-Operations`: Snowflake
   connector (`snowflake-sdk`), an **hourly cache** layer (scheduled job →
   cached query results), charting lib, and the **Summary page** as the first
   build. Then iterate page-by-page.

## 8. Useful technical notes

- Always **fully qualify** Snowflake names: `PROD_ANALYTICS.<schema>.<object>`
  (no default DB/schema on the `ANALYST` role).
- Get a view's logic with
  `SELECT GET_DDL('VIEW','PROD_ANALYTICS.BI_DATASET_VIEWS.<NAME>');`
- Get columns with
  `SELECT COLUMN_NAME, DATA_TYPE FROM PROD_ANALYTICS.INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA=... AND TABLE_NAME=... ORDER BY ORDINAL_POSITION;`
- `sql_exec` runs **one statement per call**.
- Hourly-cache architecture means the app should not hit Snowflake on every page
  load — run scheduled queries and serve cached results.
