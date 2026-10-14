interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * NASA Aviation Safety Reporting System (ASRS) — de-identified aviation
 * safety incident narratives.
 *
 * Pilots, controllers, mechanics, flight attendants and dispatchers report
 * these voluntarily; NASA de-identifies and codes each one before release.
 * NASA does not verify or validate the contents of a report, and the program
 * itself cautions that voluntary reporting is not a random sample of actual
 * events — a topic with many reports is not necessarily more common, just
 * more often reported. These are the program's own words, in every response,
 * not ours.
 *
 * SOURCE: NASA ASRS publishes thirty standing "Database Report Sets" — curated
 * samples of up to 50 de-identified reports each, on fixed safety topics
 * (runway incursions, CFIT, bird strikes, fatigue, icing, NMACs, and so on).
 * NASA's own full keyword/date search ("Database Online") is a session-based,
 * multi-step ASP.NET wizard with no callable API, so this pack answers from
 * NASA's own periodic Report Set publications rather than querying that
 * wizard per request. See src/store.ts for how the data is held (D1, loaded
 * by scripts/asrs-reports/load-data.mjs — never a bundled import; see that
 * file's header for why).
 *
 * REFRESH: NASA updates each Report Set on its own irregular schedule
 * (observed: roughly every 1-5 months per topic). `node
 * scripts/asrs-reports/load-data.mjs` re-downloads all thirty and reloads
 * the store. `data_as_of` on every response is the most recent Report Set
 * update date at the time of the last load.
 */

import {
  SOURCE,
  getMeta,
  getReport,
  listTopics,
  normalizeYearMonth,
  requireDb,
  searchReports,
  shapeFull,
  shapeSummary,
} from './store.js';

function capped(limit: unknown, fallback = 50, max = 200): number {
  const n = typeof limit === 'number' ? limit : fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

const norm = (s: string) => s.toLowerCase();

const tools: McpToolExport['tools'] = [
  {
    name: 'asrs_search',
    description:
      'Search NASA ASRS (Aviation Safety Reporting System) de-identified aviation safety incident reports by keyword, with optional filters. Answers "find reports about runway incursions", "ASRS reports mentioning bird strikes near a given airport", "fatigue reports involving commuter flight crews". Matches the query against each report\'s narrative, synopsis, topic and coded anomaly. Returns, per report, the ACN (Accession Number), date, airport/state, aircraft, flight phase, synopsis and a narrative excerpt — call asrs_report with the ACN for the full narrative. Covers NASA\'s thirty standing curated Report Sets (up to 50 reports each on a fixed safety topic, such as runway incursions, CFIT, bird strikes, NMACs, icing, fatigue), not NASA\'s full database — call asrs_topics to see which topics and date ranges are covered before concluding a topic has no reports.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword(s) to search for in the report narrative, synopsis, topic and coded anomaly, e.g. "runway incursion", "bird strike", "fatigue". Multiple words require ALL of them to appear (not necessarily adjacent).' },
        date_from: { type: 'string', description: 'Only include reports from this year-month or later, e.g. "2024-06" or "2024". Reports are dated by the month ASRS recorded them.' },
        date_to: { type: 'string', description: 'Only include reports up to this year-month, e.g. "2025-01".' },
        aircraft: { type: 'string', description: 'Filter by aircraft/operator category substring, e.g. "widebody", "commercial fixed wing", "helicopter".' },
        phase: { type: 'string', description: 'Filter by flight phase substring, e.g. "taxi", "landing", "initial approach", "cruise".' },
        limit: { type: 'number', description: 'Max reports to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'asrs_report',
    description:
      'Fetch one NASA ASRS aviation safety report by its ACN (Accession Number) — the full de-identified narrative plus every coded field (date, airport, state, aircraft, flight phase, coded anomaly types, contributing factors) and the official synopsis. Use after asrs_search returns a report\'s ACN and you need the complete narrative rather than the excerpt.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        acn: { type: 'string', description: 'The report\'s ACN (Accession Number), e.g. "2093064". Returned by asrs_search.' },
      },
      required: ['acn'],
    },
  },
  {
    name: 'asrs_topics',
    description:
      'List the thirty safety topics NASA ASRS Report Sets cover (runway incursions, CFIT, bird strikes, fatigue, icing, NMACs, and so on), each with its report count and when NASA last updated that topic\'s Report Set. Use before asrs_search to check whether a topic is covered at all and how current it is, so a search returning nothing can be told apart from a topic this pack does not track.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function noMatch(hint: string, extra?: Record<string, unknown>) {
  return { found: false, reason: 'no_match', hint, ...SOURCE, ...extra };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'asrs_search': {
      const db = requireDb(args._d1);
      const queryRaw = typeof args.query === 'string' ? args.query.trim() : '';
      const terms = queryRaw ? norm(queryRaw).split(/\s+/).filter(Boolean) : [];
      const dateFrom = normalizeYearMonth(args.date_from);
      const dateTo = normalizeYearMonth(args.date_to);
      const aircraft = typeof args.aircraft === 'string' && args.aircraft.trim() ? norm(args.aircraft.trim()) : null;
      const phase = typeof args.phase === 'string' && args.phase.trim() ? norm(args.phase.trim()) : null;
      const limit = capped(args.limit);

      const { rows, total } = await searchReports(db, { terms, dateFrom, dateTo, aircraft, phase, limit });
      const meta = await getMeta(db);

      if (!total) {
        return noMatch(
          queryRaw
            ? `No report matched "${queryRaw}" with those filters. Call asrs_topics to see which of the thirty covered topics and date ranges exist — this pack holds NASA's curated Report Sets, not its full database.`
            : 'No report matched those filters. Call asrs_topics to see covered topics and date ranges.',
          { data_as_of: meta.data_as_of },
        );
      }
      return {
        found: true,
        returned: rows.length,
        total_matching: total,
        truncated: total > rows.length,
        reports: rows.map(shapeSummary),
        ...SOURCE,
        data_as_of: meta.data_as_of,
      };
    }

    case 'asrs_report': {
      const db = requireDb(args._d1);
      const acn = typeof args.acn === 'string' ? args.acn.trim() : '';
      const meta = await getMeta(db);
      if (!acn) return noMatch('Provide an ACN — get one from asrs_search.', { data_as_of: meta.data_as_of });
      const r = await getReport(db, acn);
      if (!r) {
        return noMatch(`No report with ACN "${acn}" in this pack's dataset. Get an ACN from asrs_search first.`, { data_as_of: meta.data_as_of });
      }
      return { found: true, ...shapeFull(r), ...SOURCE, data_as_of: meta.data_as_of };
    }

    case 'asrs_topics': {
      const db = requireDb(args._d1);
      const topics = await listTopics(db);
      const meta = await getMeta(db);
      return {
        found: true,
        topic_count: topics.length,
        total_reports: meta.total_reports,
        topics: topics.map((t) => ({
          topic_slug: t.slug,
          topic: t.topic,
          reports: t.record_count,
          nasa_update_number: t.update_number,
          nasa_last_updated: t.update_date,
        })),
        ...SOURCE,
        data_as_of: meta.data_as_of,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
