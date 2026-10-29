# @pipeworx/asrs-reports

De-identified aviation safety incident narratives from NASA's Aviation Safety
Reporting System (ASRS) — search by keyword, date, aircraft or flight phase,
or fetch one report's full narrative by its ACN.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `asrs_search(query?, date_from?, date_to?, aircraft?, phase?, limit?)` —
  keyword search across narrative, synopsis, topic and coded anomaly, with
  optional date-range, aircraft and flight-phase filters. Returns each
  report's ACN, date, airport/state, aircraft, flight phase, synopsis and a
  narrative excerpt.
- `asrs_report(acn)` — one report's full narrative and every coded field
  (date, airport, state, aircraft, flight phase, coded anomaly, contributing
  factors) plus the official synopsis.
- `asrs_topics()` — the thirty safety topics this pack covers, each with its
  report count and NASA's own last-updated date for that topic.

## Auth

Keyless.

## Data sources

- NASA Aviation Safety Reporting System (ASRS), Database Report Sets — NASA
  Ames Research Center's voluntary, confidential aviation-safety reporting
  program (contracted to Booz Allen Hamilton), publishing curated samples of
  de-identified incident reports on thirty standing safety topics (runway
  incursions, controlled flight toward terrain, bird/animal strikes, flight
  crew fatigue, icing, near midair collisions, and more). Each topic's report
  set is updated by NASA on its own schedule and the pack carries NASA's own
  per-topic update date. NASA's full keyword/date database search
  ("Database Online") has no callable API — it is a session-based, multi-step
  wizard — so this pack answers from NASA's own periodic Report Set
  publications rather than querying that wizard per request.

**Built from NASA's own PDFs, not a live query.** NASA publishes each Report
Set as a PDF of up to 50 pre-screened reports. This pack parses the thirty
current PDFs into structured records (1,412 unique reports after
de-duplicating reports filed under more than one topic — `also_filed_under`
on `asrs_report` names the others). `data_as_of` on every response is the
most recent of NASA's thirty per-topic update dates as of the last refresh.

**Coverage, not completeness.** This pack covers only NASA's thirty standing
Report Set topics, not ASRS's full report archive (NASA's own search tool
covers far more but has no API). `asrs_topics` lists exactly what is covered
and how current each topic is — check it before concluding a topic has zero
reports.

**Caveats NASA states on every Report Set, carried on every response:**
reports are voluntarily submitted and not corroborated by NASA, the FAA or
the NTSB, so the number of reports on a topic cannot be used to infer how
common that problem actually is.

**Store, not a bundled import.** The 1,412 reports (full narrative text
included) live in a D1 database the gateway hands this pack as `_d1`
(`"d1Binding": "ASRS_DB"` in `pack-manifest.json`; schema + queries in
`src/store.ts`) — never a bundled `import ... from './data.json'`. An
earlier version of this pack baked the same reports as a 3.6 MB
`src/data.json` import, which pushed the gateway Worker over its bundle
ceiling and blocked every lane's deploy for about an hour. No FTS5 — the
dataset is small enough that plain `LIKE`-based filtering costs nothing,
which also sidesteps D1's FTS5 chunked-import trap (an FTS5 index can arrive
empty with no error at all).

**Refresh:** `node scripts/asrs-reports/load-data.mjs` re-downloads and
re-parses NASA's thirty current Report Set PDFs
(`scripts/asrs-reports/fetch-asrs-pdfs.py`, needs `pip install pypdf` once —
build-time only, never bundled into the pack) and reloads the D1 store.
NASA updates each topic on an irregular schedule (observed anywhere from ~1
to ~5 months between updates per topic); re-run the loader periodically.
Needs `wrangler` authenticated to the Pipeworx Cloudflare account — this
writes to production D1, so only run it with that access.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "asrs-reports": {
      "url": "https://gateway.pipeworx.io/asrs-reports/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/asrs-reports/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/asrs_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"runway incursion","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/asrs_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-asrs-reports` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/asrs-reports/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "asrs-reports": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-asrs-reports"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Asrs Reports data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
