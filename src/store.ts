/**
 * D1 reads for mcps/asrs-reports.
 *
 * Data: NASA's thirty standing ASRS "Database Report Set" PDFs, parsed into
 * rows and loaded into a D1 database the gateway hands this pack as `_d1`
 * (pack-manifest "d1Binding": "ASRS_DB") -- never by a deploy. Loader:
 * scripts/asrs-reports/load-data.mjs (regenerates from NASA's current PDFs
 * via scripts/refresh-asrs-reports.py, then writes/executes the D1 import).
 *
 * Kept OUT of the gateway bundle on purpose (fleet #3060 rework, 2026-10-14):
 * an earlier version baked 1,412 reports' full narratives as a 3.6 MB
 * src/data.json import, which together with another pack's baked data
 * pushed the gateway Worker over its bundle ceiling (28 MiB raw / 6.5 MiB
 * gzip) and blocked every lane's deploy for about an hour. Never repeat
 * that -- any pack dataset over ~200 KB belongs in a store, not an import.
 *
 * Small dataset (1,412 rows) -- plain LIKE-based filtering, no FTS5. An
 * FTS5 virtual table on D1 can arrive EMPTY through a chunked import with no
 * error at all (reference-d1-fts5-import-trap); at this row count a LIKE
 * scan costs nothing and sidesteps that trap entirely.
 *
 * NOTE on placeholders: D1's local smoke shim mangles NUMBERED placeholders
 * (`?1`) -- every statement here uses plain, positional `?`.
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'asrs-reports: the ASRS report store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'NASA Aviation Safety Reporting System (ASRS), Database Report Sets',
  source_url: 'https://asrs.arc.nasa.gov/search/database.html',
  caveat:
    'ASRS reports are voluntarily submitted and not corroborated by NASA, the FAA, or the NTSB. The existence of reports on a topic cannot be used to infer how common that problem is in the National Airspace System.',
};

export interface ReportRow {
  acn: string;
  date: string | null; // YYYYMM
  locale: string | null;
  state: string | null;
  aircraft: string | null;
  flight_phase: string; // JSON array, stored as text
  anomaly: string; // JSON array, stored as text
  narrative: string | null;
  synopsis: string | null;
  topic_slug: string;
  topic: string;
  also_in: string; // JSON array, stored as text
}

export interface TopicRow {
  slug: string;
  topic: string;
  update_number: string | null;
  update_date: string | null;
  record_count: number;
}

const arr = (s: string | null | undefined): string[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function excerpt(text: string | null, len = 400): string | null {
  if (!text) return null;
  if (text.length <= len) return text;
  return `${text.slice(0, len).trim()}…`;
}

export function shapeSummary(r: ReportRow) {
  return {
    acn: r.acn,
    date: formatDate(r.date),
    airport_or_locale: r.locale,
    state: r.state,
    aircraft: r.aircraft,
    flight_phase: arr(r.flight_phase),
    anomaly: arr(r.anomaly),
    topic: r.topic,
    synopsis: r.synopsis,
    narrative_excerpt: excerpt(r.narrative),
  };
}

export function shapeFull(r: ReportRow) {
  return {
    acn: r.acn,
    date: formatDate(r.date),
    airport_or_locale: r.locale,
    state: r.state,
    aircraft: r.aircraft,
    flight_phase: arr(r.flight_phase),
    anomaly: arr(r.anomaly),
    topic: r.topic,
    also_filed_under: arr(r.also_in),
    synopsis: r.synopsis,
    narrative: r.narrative,
  };
}

export function formatDate(yyyymm: string | null): string | null {
  if (!yyyymm || yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
}

/** YYYYMM -> comparable number; also accepts "YYYY-MM" / "YYYY" from a caller. */
export function normalizeYearMonth(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 4) return Number(digits) * 100 + 1; // year only -> Jan
  if (digits.length >= 6) return Number(digits.slice(0, 6));
  return null;
}

export interface SearchFilters {
  terms: string[];
  dateFrom: number | null;
  dateTo: number | null;
  aircraft: string | null;
  phase: string | null;
  limit: number;
}

/** Builds WHERE ... args for asrs_search. Each query TERM requires a match
 *  in narrative, synopsis, topic OR anomaly (its own OR'd clause); terms are
 *  AND'd together. Plain `?` placeholders throughout (see file header). */
function buildWhere(f: SearchFilters): { clause: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  for (const t of f.terms) {
    clauses.push('(LOWER(narrative) LIKE ? OR LOWER(synopsis) LIKE ? OR LOWER(topic) LIKE ? OR LOWER(anomaly) LIKE ?)');
    const like = `%${t}%`;
    args.push(like, like, like, like);
  }
  if (f.dateFrom != null) {
    clauses.push('date >= ?');
    args.push(String(f.dateFrom));
  }
  if (f.dateTo != null) {
    clauses.push('date <= ?');
    args.push(String(f.dateTo));
  }
  if (f.aircraft) {
    clauses.push('LOWER(aircraft) LIKE ?');
    args.push(`%${f.aircraft}%`);
  }
  if (f.phase) {
    clauses.push('LOWER(flight_phase) LIKE ?');
    args.push(`%${f.phase}%`);
  }
  return { clause: clauses.length ? clauses.join(' AND ') : '1=1', args };
}

export async function searchReports(db: D1Like, f: SearchFilters): Promise<{ rows: ReportRow[]; total: number }> {
  const { clause, args } = buildWhere(f);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM asrs_report WHERE ${clause}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);
  if (total === 0) return { rows: [], total: 0 };
  const { results } = await db
    .prepare(`SELECT * FROM asrs_report WHERE ${clause} ORDER BY date DESC LIMIT ?`)
    .bind(...args, f.limit)
    .all<ReportRow>();
  return { rows: results, total };
}

export async function getReport(db: D1Like, acn: string): Promise<ReportRow | null> {
  return db.prepare('SELECT * FROM asrs_report WHERE acn = ?').bind(acn).first<ReportRow>();
}

export interface Meta {
  data_as_of: string | null;
  total_reports: number;
}

let cachedMeta: Meta | null = null;
export async function getMeta(db: D1Like): Promise<Meta> {
  if (cachedMeta) return cachedMeta;
  const row = await db.prepare("SELECT value FROM asrs_meta WHERE key = 'data_as_of'").first<{ value: string }>();
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM asrs_report').first<{ n: number }>();
  cachedMeta = { data_as_of: row?.value ?? null, total_reports: Number(countRow?.n ?? 0) };
  return cachedMeta;
}

export async function listTopics(db: D1Like): Promise<TopicRow[]> {
  const { results } = await db.prepare('SELECT * FROM asrs_topic ORDER BY slug').all<TopicRow>();
  return results;
}
