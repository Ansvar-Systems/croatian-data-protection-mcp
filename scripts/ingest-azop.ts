#!/usr/bin/env tsx
/**
 * AZOP (azop.hr) ingestion crawler for the Croatian Data Protection MCP.
 *
 * Three-phase pipeline:
 *   Phase 1 — Discovery: parse WordPress XML sitemaps to collect post/page URLs
 *   Phase 2 — Decisions: fetch decision/fine announcement pages, parse HTML, insert
 *   Phase 3 — Guidelines: fetch guidance/smjernice pages and PDFs, parse, insert
 *
 * The AZOP site uses a Divi theme that renders most content client-side.
 * The crawler extracts text from the Divi HTML structures (et_pb_text modules)
 * and falls back to generic article/main content selectors.
 *
 * Usage:
 *   npx tsx scripts/ingest-azop.ts                 # full crawl
 *   npx tsx scripts/ingest-azop.ts --dry-run       # discover + parse, no DB writes
 *   npx tsx scripts/ingest-azop.ts --resume        # skip already-ingested URLs
 *   npx tsx scripts/ingest-azop.ts --force          # drop existing data first
 *   npx tsx scripts/ingest-azop.ts --limit 20      # process first 20 URLs only
 *
 * Environment:
 *   AZOP_DB_PATH — SQLite database path (default: data/azop.db)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["AZOP_DB_PATH"] ?? "data/azop.db";
const STATE_DIR = resolve(__dirname, "../data/crawl-state");
const STATE_PATH = resolve(STATE_DIR, "ingest-state.json");

const BASE_URL = "https://azop.hr";
const SITEMAP_INDEX_URL = `${BASE_URL}/sitemap.xml`;
const POST_SITEMAP_URL = `${BASE_URL}/post-sitemap.xml`;
const PAGE_SITEMAP_URL = `${BASE_URL}/page-sitemap.xml`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "AnsvarAZOPCrawler/1.0 (+https://ansvar.eu; data-protection-research)";

// ─── URL classification patterns ────────────────────────────────────────────

/** Slug patterns that indicate a decision or fine announcement. */
const DECISION_PATTERNS = [
  /upravn[ae]-novcane?-kazn[ei]/,
  /rjesenje/,
  /izrecen[aeo]/,
  /izdan[aeo]/,
  /kazn[aeu]/,
  /sankcij/,
  /prekrsaj/,
  /povreda/,
  /administrativna/,
  /new-administrative-fine/,
  /fine/,
];

/** Slug patterns that indicate a guideline or opinion. */
const GUIDELINE_PATTERNS = [
  /smjernic/,
  /vodic/,
  /misljenje/,
  /preporuk/,
  /publikacij/,
  /prirucnik/,
  /upute/,
  /savjet/,
  /obrada-osobnih-podataka/,
  /zastita-osobnih-podataka/,
  /pravni-temelj/,
  /privola/,
  /kolacic/,
  /videonadzor/,
  /gdpr/,
  /procjena-ucinka/,
  /legitimni-interes/,
  /dpia/,
  /kodeks/,
  /prijenos-podataka/,
  /transfer/,
  /breach/,
  /povreda-osobnih-podataka/,
];

/** URLs or slug patterns to skip entirely (events, job postings, etc.). */
const SKIP_PATTERNS = [
  /arc-projekt/,
  /radionica/,
  /workshop/,
  /edukacij/,
  /konferencij/,
  /conference/,
  /seminar/,
  /webinar/,
  /predavanj/,
  /presentation/,
  /zaposljavanj/,
  /oglas-za-prijam/,
  /plenar[ni]/,
  /sjednic/,
  /sastanak/,
  /twinning/,
  /evaluacij/,
  /obiljezavanj/,
  /europski-dan/,
  /svjetski-dan/,
  /dan-sigurnijeg/,
  /nagradna-igra/,
  /priopcenj/,
  /press-release/,
  /intervju/,
  /gostovanj/,
  /sporazum/,
  /memorandum/,
  /anketa/,
  /survey/,
  /carnet/,
  /forum/,
  /okrugli-stol/,
  /t4data/,
  /panelift/,
  /pro-res/,
  /kampanj/,
  /campaign/,
  /promotivni/,
  /odrzana?-/,
  /prijave-za/,
  /e-open-space/,
  /potrosacki/,
  /azop-obiljez/,
  /potpisan/,
  /suradnj/,
  /cooperation/,
  /odrzano/,
  /10-years/,
  /raisinig/,
  /resume-of-the-decision/,
  /statement-of/,
  /obavijest-za-korisnike/,
  /promjena-adrese/,
  /savjetodavn/,
  /jacanje-suradnje/,
  /stolar-gdjphr/,
  /webinar-kako-zastititi/,
  /demokracija-ljudska-prava/,
  /4\d{3}-2/,
  /5\d{3}-2/,
  /6\d{3}-2/,
];

// ─── CLI args ───────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  limit: number | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    dryRun: false,
    resume: false,
    force: false,
    limit: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") { opts.dryRun = true; continue; }
    if (arg === "--resume") { opts.resume = true; continue; }
    if (arg === "--force") { opts.force = true; continue; }
    if (arg === "--limit" && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.limit = parsed;
      i++;
      continue;
    }
  }

  return opts;
}

// ─── Crawl state (for --resume) ─────────────────────────────────────────────

interface CrawlState {
  ingested_urls: string[];
  last_run: string;
}

function loadState(): CrawlState {
  if (!existsSync(STATE_PATH)) {
    return { ingested_urls: [], last_run: "" };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as CrawlState;
  } catch {
    return { ingested_urls: [], last_run: "" };
  }
}

function saveState(state: CrawlState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hr,en;q=0.5",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) return response;

      if (response.status === 429 || response.status >= 500) {
        const wait = RETRY_BACKOFF_MS * attempt;
        console.warn(`  WARN: HTTP ${response.status} for ${url}, retry ${attempt}/${retries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      // 4xx (not 429) — do not retry
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        console.warn(`  WARN: Timeout for ${url}, retry ${attempt}/${retries}`);
      } else {
        console.warn(`  WARN: ${msg}, retry ${attempt}/${retries}`);
      }
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetry(url);
  return response.text();
}

// ─── Phase 1: Sitemap discovery ─────────────────────────────────────────────

interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

async function discoverSitemapUrls(): Promise<SitemapEntry[]> {
  console.log("\n=== Phase 1: Discover URLs from sitemaps ===\n");

  const entries: SitemapEntry[] = [];

  for (const sitemapUrl of [POST_SITEMAP_URL, PAGE_SITEMAP_URL]) {
    console.log(`  Fetching ${sitemapUrl}`);
    try {
      const xml = await fetchText(sitemapUrl);
      const $ = cheerio.load(xml, { xmlMode: true });

      $("url").each((_i, el) => {
        const loc = $(el).find("loc").text().trim();
        const lastmod = $(el).find("lastmod").text().trim() || null;
        if (loc) entries.push({ url: loc, lastmod });
      });

      console.log(`    Found ${entries.length} URLs so far`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  WARN: Failed to fetch sitemap ${sitemapUrl}: ${msg}`);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(`  Total unique URLs discovered: ${unique.length}`);
  return unique;
}

// ─── URL classification ─────────────────────────────────────────────────────

type ContentType = "decision" | "guideline" | "skip";

function classifyUrl(url: string): ContentType {
  const slug = url.replace(BASE_URL, "").toLowerCase();

  // Skip non-content pages
  if (SKIP_PATTERNS.some((p) => p.test(slug))) return "skip";

  // Decisions and fines
  if (DECISION_PATTERNS.some((p) => p.test(slug))) return "decision";

  // Guidelines and opinions
  if (GUIDELINE_PATTERNS.some((p) => p.test(slug))) return "guideline";

  return "skip";
}

// ─── HTML parsing ───────────────────────────────────────────────────────────

interface ParsedPage {
  title: string;
  date: string | null;
  bodyText: string;
  bodyHtml: string;
  pdfLinks: string[];
}

function parseDiviPage(html: string, url: string): ParsedPage {
  const $ = cheerio.load(html);

  // Title: try og:title, then <title>, then h1
  let title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    "";

  // Strip " - Agencija za zaštitu osobnih podataka" suffix
  title = title.replace(/\s*[-–—]\s*Agencija za zaštitu osobnih podataka$/i, "").trim();

  // Date: try og:article:published_time, then datePublished in JSON-LD, then dateModified
  let date: string | null = null;

  const ogDate = $('meta[property="article:published_time"]').attr("content");
  if (ogDate) {
    date = ogDate.slice(0, 10);
  }

  if (!date) {
    // Parse JSON-LD
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (date) return;
      try {
        const ld = JSON.parse($(el).text()) as Record<string, unknown>;
        if (typeof ld["datePublished"] === "string") {
          date = (ld["datePublished"] as string).slice(0, 10);
        } else if (typeof ld["dateModified"] === "string") {
          date = (ld["dateModified"] as string).slice(0, 10);
        }
      } catch { /* skip malformed JSON-LD */ }
    });
  }

  // Content extraction: Divi uses .et_pb_text_inner for text modules
  // Also try .entry-content, .post-content, article, #main-content
  const contentSelectors = [
    ".et_pb_text_inner",
    ".et_pb_post_content",
    ".entry-content",
    ".post-content",
    "article .content",
    "#main-content",
    "article",
    "main",
  ];

  let bodyHtml = "";
  let bodyText = "";

  for (const selector of contentSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      const parts: string[] = [];
      elements.each((_i, el) => {
        const text = $(el).text().trim();
        if (text.length > 50) { // Skip tiny fragments
          parts.push(text);
        }
      });

      if (parts.length > 0) {
        bodyText = parts.join("\n\n");
        bodyHtml = elements
          .map((_i, el) => $(el).html() || "")
          .get()
          .join("\n");
        break;
      }
    }
  }

  // If no body extracted, fall back to full page text minus nav/footer
  if (!bodyText) {
    $("nav, footer, header, script, style, .et_pb_menu, .et_pb_footer").remove();
    bodyText = $("body").text().replace(/\s+/g, " ").trim();
  }

  // Extract PDF links
  const pdfLinks: string[] = [];
  $('a[href$=".pdf"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) {
      const absolute = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      pdfLinks.push(absolute);
    }
  });

  return { title, date, bodyText, bodyHtml, pdfLinks };
}

// ─── Content extraction helpers ─────────────────────────────────────────────

/** Extract GDPR article references from text. */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  // Match patterns like "čl. 5.", "čl. 32. GDPR", "članka 6.", "Article 5"
  const patterns = [
    /čl(?:ank[aeu]?)?\s*\.?\s*(\d{1,3})\./gi,
    /article\s+(\d{1,3})/gi,
    /čl\.\s*(\d{1,3})/gi,
    /članc[aiu]\s+(\d{1,3})/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const num = match[1]!;
      const n = parseInt(num, 10);
      // GDPR articles go 1-99, skip numbers that are clearly not articles
      if (n >= 1 && n <= 99) {
        articles.add(num);
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Try to extract entity name from decision text. */
function extractEntityName(text: string): string | null {
  const patterns = [
    // "kazna/kaznu <entity> d.o.o./d.d./j.d.o.o."
    /(?:kazn[aue]|izrečen[ao])\s+(?:[\w\s]+?\s+)?(?:voditelju obrade\s+)?([A-ZČĆŽŠĐ][\w\s,.-]+?\s+(?:d\.o\.o\.|d\.d\.|j\.d\.o\.o\.))/i,
    // Generic entity with d.o.o. or d.d.
    /([A-ZČĆŽŠĐ][\w\s,.-]+?\s+(?:d\.o\.o\.|d\.d\.|j\.d\.o\.o\.))/,
    // "voditelju obrade — <entity>"
    /voditelju obrade\s+[—–-]\s*([A-ZČĆŽŠĐ][\w\s,.-]+?)(?:\s+(?:zbog|radi|za|u))/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const name = match[1].trim();
      if (name.length > 3 && name.length < 120) return name;
    }
  }

  return null;
}

/** Try to extract fine amount in EUR or HRK from text. */
function extractFineAmount(text: string): number | null {
  const patterns = [
    // "2,26 milijuna eura" / "2.26 million EUR"
    /(\d{1,3}(?:[.,]\d+)?)\s*milij[ua]n[aeu]?\s*(?:eur[ao]?|€)/i,
    // "270.700 eura" / "350.500,00 eura"
    /(\d{1,3}(?:\.\d{3})+(?:,\d{2})?)\s*(?:eur[ao]?|€)/i,
    // "500 000 HRK"
    /(\d{1,3}(?:[\s.]\d{3})+(?:,\d{2})?)\s*(?:HRK|kuna|kn)/i,
    // "€2,260,000"
    /€\s*(\d{1,3}(?:[.,]\d{3})+)/i,
    // "80.000 eura"
    /(\d{1,3}(?:\.\d{3})*)\s*(?:eur[ao]?|€)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let raw = match[1];
      const isMillions = /milij/i.test(text.slice((match.index ?? 0), (match.index ?? 0) + match[0].length + 20));

      // Normalise number: "270.700" → 270700, "2,26" → 2.26
      if (isMillions) {
        raw = raw.replace(",", ".");
        const val = parseFloat(raw) * 1_000_000;
        if (Number.isFinite(val) && val > 0) return val;
      } else {
        // Croatian format: 270.700,00 → 270700.00
        raw = raw.replace(/\./g, "").replace(",", ".");
        const val = parseFloat(raw);
        if (Number.isFinite(val) && val > 0) return val;
      }
    }
  }

  // HRK → EUR rough conversion (1 EUR ≈ 7.5345 HRK, fixed rate since 2023-01-01)
  const hrkPatterns = [
    /(\d{1,3}(?:[.,\s]\d{3})+(?:,\d{2})?)\s*(?:HRK|kuna|kn)/i,
    /(\d{1,3}(?:\.\d{3})*)\s*(?:HRK|kuna|kn)/i,
  ];

  for (const pattern of hrkPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let raw = match[1].replace(/\s/g, "");
      raw = raw.replace(/\./g, "").replace(",", ".");
      const hrkVal = parseFloat(raw);
      if (Number.isFinite(hrkVal) && hrkVal > 0) {
        return Math.round((hrkVal / 7.5345) * 100) / 100;
      }
    }
  }

  return null;
}

/** Classify decision type from text and URL slug. */
function classifyDecisionType(text: string, slug: string): string {
  const lower = text.toLowerCase();
  if (/kazn[aeu]|fine|penalty/.test(slug) || /upravn[aeu] novčan[aeu] kazn[aeu]/.test(lower)) {
    return "kazna";
  }
  if (/upozorenje|warning/.test(lower)) return "upozorenje";
  if (/nalog|order/.test(lower)) return "nalog";
  if (/zabran|prohibition/.test(lower)) return "zabrana";
  return "rješenje";
}

/** Classify guideline type from text and URL slug. */
function classifyGuidelineType(text: string, slug: string): string {
  if (/smjernic/.test(slug)) return "smjernica";
  if (/vodic/.test(slug)) return "vodič";
  if (/misljenje/.test(slug)) return "mišljenje";
  if (/preporuk/.test(slug)) return "preporuka";
  if (/upute/.test(slug)) return "upute";
  if (/prirucnik/.test(slug)) return "priručnik";

  const lower = text.toLowerCase();
  if (/smjernic/.test(lower)) return "smjernica";
  if (/vodič/.test(lower)) return "vodič";
  if (/mišljenje/.test(lower)) return "mišljenje";
  if (/preporuk/.test(lower)) return "preporuka";
  return "smjernica";
}

/** Assign topic IDs based on text content. */
function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: string[] = [];

  const topicSignals: [string, RegExp[]][] = [
    ["consent", [/privol[aeu]/i, /suglasnost/i, /consent/i]],
    ["cookies", [/kolačić/i, /cookie/i, /tragač/i, /tracker/i, /banner/i]],
    ["transfers", [/prijenos/i, /transfer/i, /treć[aei]m zemlj/i, /scc/i, /standardn[eai] ugovorn/i, /schrems/i]],
    ["dpia", [/procjen[aeu] učinka/i, /dpia/i, /impact assessment/i]],
    ["breach_notification", [/povred[aeu] osobnih/i, /breach/i, /notifikacij/i, /72 sat/i]],
    ["privacy_by_design", [/ugrađen[aoi] zaštit/i, /privacy by design/i, /tehničk[aei] mjere/i, /organizacijske mjere/i, /sigurnosne mjere/i]],
    ["employee_monitoring", [/zaposlen/i, /radn[io] odnos/i, /nadzor zaposlen/i, /praćenje zaposlen/i, /employee/i, /geolokacij/i]],
    ["health_data", [/zdravstven/i, /medicins/i, /health/i, /bolnic/i, /pacijent/i]],
    ["children", [/djec/i, /maloljetn/i, /children/i, /child/i]],
  ];

  for (const [id, patterns] of topicSignals) {
    if (patterns.some((p) => p.test(lower))) {
      topics.push(id);
    }
  }

  return topics;
}

/** Generate a stable reference from a URL slug and date. */
function generateReference(url: string, date: string | null, index: number): string {
  const slug = url.replace(BASE_URL, "").replace(/\//g, "").slice(0, 60);
  const year = date ? date.slice(0, 4) : "UNKNOWN";
  const hash = slug.split("").reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0x7fff, 0);
  return `AZOP-${year}-${hash.toString(16).padStart(4, "0").toUpperCase()}-${index}`;
}

/** Trim whitespace and collapse runs of blank lines. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Database helpers ───────────────────────────────────────────────────────

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`  Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function ensureTopics(db: Database.Database): void {
  const topics = [
    { id: "consent", name_local: "Privola", name_en: "Consent", description: "Prikupljanje, valjanost i povlačenje privole za obradu osobnih podataka (čl. 7. GDPR-a)." },
    { id: "cookies", name_local: "Kolačići i tragači", name_en: "Cookies and trackers", description: "Postavljanje i čitanje kolačića i tragača na terminalima korisnika (ePrivacy direktiva)." },
    { id: "transfers", name_local: "Međunarodni prijenosi podataka", name_en: "International transfers", description: "Prijenos osobnih podataka trećim zemljama ili međunarodnim organizacijama (čl. 44-49. GDPR-a)." },
    { id: "dpia", name_local: "Procjena učinka na zaštitu podataka (DPIA)", name_en: "Data Protection Impact Assessment (DPIA)", description: "Procjena rizika za prava i slobode osoba za obradu visoke rizičnosti (čl. 35. GDPR-a)." },
    { id: "breach_notification", name_local: "Povreda osobnih podataka", name_en: "Data breach notification", description: "Prijava povreda osobnih podataka AZOP-u i ispitanicima (čl. 33-34. GDPR-a)." },
    { id: "privacy_by_design", name_local: "Ugrađena zaštita podataka", name_en: "Privacy by design", description: "Integracija zaštite podataka u projektiranje i zadane postavke (čl. 25. GDPR-a)." },
    { id: "employee_monitoring", name_local: "Nadzor zaposlenika", name_en: "Employee monitoring", description: "Obrada osobnih podataka u radnom odnosu i nadzor zaposlenika." },
    { id: "health_data", name_local: "Zdravstveni podaci", name_en: "Health data", description: "Obrada zdravstvenih podataka — posebne kategorije s pojačanom zaštitom (čl. 9. GDPR-a)." },
    { id: "children", name_local: "Podaci djece", name_en: "Children's data", description: "Zaštita osobnih podataka maloljetnika u mrežnim uslugama (čl. 8. GDPR-a)." },
    { id: "video_surveillance", name_local: "Videonadzor", name_en: "Video surveillance", description: "Zakonski uvjeti za sustave videonadzora i nadzorne kamere." },
    { id: "direct_marketing", name_local: "Izravni marketing", name_en: "Direct marketing", description: "Obrada osobnih podataka u svrhu izravnog marketinga i profiliranja." },
    { id: "public_sector", name_local: "Javni sektor", name_en: "Public sector", description: "Obrada osobnih podataka u tijelima javne vlasti i javnim institucijama." },
    { id: "telecom", name_local: "Telekomunikacije", name_en: "Telecommunications", description: "Zaštita osobnih podataka u sektoru elektroničkih komunikacija." },
    { id: "financial", name_local: "Financijski sektor", name_en: "Financial sector", description: "Obrada osobnih podataka u bankama, osiguravajućim društvima i financijskim institucijama." },
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const t of topics) insert.run(t.id, t.name_local, t.name_en, t.description);
  });
  tx();
}

// ─── Phase 2 & 3: Fetch + parse + insert ────────────────────────────────────

interface IngestStats {
  discovered: number;
  skipped_pattern: number;
  skipped_resume: number;
  decisions_inserted: number;
  decisions_skipped_dup: number;
  guidelines_inserted: number;
  guidelines_skipped_dup: number;
  fetch_errors: number;
  parse_errors: number;
}

async function ingestPages(
  entries: SitemapEntry[],
  db: Database.Database | null,
  cli: CliArgs,
  state: CrawlState,
): Promise<IngestStats> {
  const stats: IngestStats = {
    discovered: entries.length,
    skipped_pattern: 0,
    skipped_resume: 0,
    decisions_inserted: 0,
    decisions_skipped_dup: 0,
    guidelines_inserted: 0,
    guidelines_skipped_dup: 0,
    fetch_errors: 0,
    parse_errors: 0,
  };

  const ingestedSet = new Set(state.ingested_urls);
  const newlyIngested: string[] = [];

  // Prepared statements (only if not dry-run)
  const insertDecision = db?.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGuideline = db?.prepare(`
    INSERT OR IGNORE INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkDecisionRef = db?.prepare(
    "SELECT 1 FROM decisions WHERE reference = ? LIMIT 1",
  );

  const checkGuidelineTitle = db?.prepare(
    "SELECT 1 FROM guidelines WHERE title = ? LIMIT 1",
  );

  // Classify and filter
  interface ClassifiedEntry {
    url: string;
    lastmod: string | null;
    type: ContentType;
  }

  const classified: ClassifiedEntry[] = [];
  for (const entry of entries) {
    const type = classifyUrl(entry.url);
    if (type === "skip") {
      stats.skipped_pattern++;
      continue;
    }
    if (cli.resume && ingestedSet.has(entry.url)) {
      stats.skipped_resume++;
      continue;
    }
    classified.push({ ...entry, type });
  }

  // Sort: decisions first (higher priority), then by date descending
  classified.sort((a, b) => {
    if (a.type !== b.type) return a.type === "decision" ? -1 : 1;
    return (b.lastmod ?? "").localeCompare(a.lastmod ?? "");
  });

  const toProcess = cli.limit ? classified.slice(0, cli.limit) : classified;

  console.log(`\n=== Phase 2 & 3: Fetch and ingest ===`);
  console.log(`  Classified: ${classified.length} pages (${classified.filter(e => e.type === "decision").length} decisions, ${classified.filter(e => e.type === "guideline").length} guidelines)`);
  console.log(`  Processing: ${toProcess.length}${cli.limit ? ` (limited to ${cli.limit})` : ""}`);
  console.log(`  Skipped by pattern: ${stats.skipped_pattern}`);
  console.log(`  Skipped by resume: ${stats.skipped_resume}`);
  console.log("");

  let decisionIndex = 0;
  let guidelineIndex = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i]!;
    const progress = `[${i + 1}/${toProcess.length}]`;

    console.log(`${progress} ${entry.type.toUpperCase()} ${entry.url}`);

    // Rate limit
    if (i > 0) await sleep(RATE_LIMIT_MS);

    let html: string;
    try {
      html = await fetchText(entry.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: Failed to fetch: ${msg}`);
      stats.fetch_errors++;
      continue;
    }

    let page: ParsedPage;
    try {
      page = parseDiviPage(html, entry.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: Failed to parse: ${msg}`);
      stats.parse_errors++;
      continue;
    }

    if (!page.title || page.bodyText.length < 100) {
      console.log(`  SKIP: Insufficient content (title: ${page.title ? "yes" : "no"}, body: ${page.bodyText.length} chars)`);
      stats.parse_errors++;
      continue;
    }

    const fullText = cleanText(page.bodyText);
    const topics = detectTopics(fullText);
    const gdprArticles = extractGdprArticles(fullText);

    if (entry.type === "decision") {
      decisionIndex++;
      const reference = generateReference(entry.url, page.date, decisionIndex);
      const entityName = extractEntityName(fullText);
      const fineAmount = extractFineAmount(fullText);
      const decisionType = classifyDecisionType(fullText, entry.url);

      // Build summary: first ~300 chars of body as a rough summary
      const summaryRaw = fullText.slice(0, 500);
      const summaryEnd = summaryRaw.lastIndexOf(".");
      const summary = summaryEnd > 100 ? summaryRaw.slice(0, summaryEnd + 1) : summaryRaw;

      console.log(`  → Decision: ${page.title.slice(0, 80)}`);
      console.log(`    ref=${reference} type=${decisionType} entity=${entityName ?? "—"} fine=${fineAmount ?? "—"} gdpr=${gdprArticles.join(",") || "—"} topics=${topics.join(",") || "—"}`);

      if (cli.dryRun) {
        stats.decisions_inserted++;
      } else if (db && insertDecision && checkDecisionRef) {
        const exists = checkDecisionRef.get(reference);
        if (exists) {
          stats.decisions_skipped_dup++;
          console.log(`    SKIP: Duplicate reference ${reference}`);
        } else {
          insertDecision.run(
            reference,
            page.title,
            page.date,
            decisionType,
            entityName,
            fineAmount,
            summary,
            fullText,
            JSON.stringify(topics),
            JSON.stringify(gdprArticles),
            "final",
          );
          stats.decisions_inserted++;
        }
      }
    } else {
      // Guideline
      guidelineIndex++;
      const reference = generateReference(entry.url, page.date, guidelineIndex);
      const guidelineType = classifyGuidelineType(fullText, entry.url);

      const summaryRaw = fullText.slice(0, 500);
      const summaryEnd = summaryRaw.lastIndexOf(".");
      const summary = summaryEnd > 100 ? summaryRaw.slice(0, summaryEnd + 1) : summaryRaw;

      console.log(`  → Guideline: ${page.title.slice(0, 80)}`);
      console.log(`    ref=${reference} type=${guidelineType} topics=${topics.join(",") || "—"}`);

      if (cli.dryRun) {
        stats.guidelines_inserted++;
      } else if (db && insertGuideline && checkGuidelineTitle) {
        const exists = checkGuidelineTitle.get(page.title);
        if (exists) {
          stats.guidelines_skipped_dup++;
          console.log(`    SKIP: Duplicate title`);
        } else {
          insertGuideline.run(
            reference,
            page.title,
            page.date,
            guidelineType,
            summary,
            fullText,
            JSON.stringify(topics),
            "hr",
          );
          stats.guidelines_inserted++;
        }
      }
    }

    newlyIngested.push(entry.url);

    // Persist state periodically (every 25 pages) for resume support
    if (!cli.dryRun && newlyIngested.length % 25 === 0) {
      state.ingested_urls.push(...newlyIngested.splice(0));
      state.last_run = new Date().toISOString();
      saveState(state);
    }
  }

  // Final state save
  if (!cli.dryRun && newlyIngested.length > 0) {
    state.ingested_urls.push(...newlyIngested);
    state.last_run = new Date().toISOString();
    saveState(state);
  }

  return stats;
}

// ─── Supplementary: known AZOP fine/decision URLs not in sitemap ────────────

function getSupplementaryUrls(): SitemapEntry[] {
  // These are AZOP decision announcement pages discovered through search
  // that may not appear in the sitemap (sitemap sometimes lags behind).
  return [
    { url: "https://azop.hr/izdane-nove-upravne-novcane-kazne-u-ukupnom-iznosu-od-270-700-eura/", lastmod: "2024-09-13" },
    { url: "https://azop.hr/devet-novih-upravnih-novcanih-kazni-u-ukupnom-iznosu-od-51-000-eura/", lastmod: null },
    { url: "https://azop.hr/sedam-novih-upravnih-novcanih-kazni-u-iznosu-od-169-000-eura/", lastmod: "2025-03-24" },
    { url: "https://azop.hr/agenciji-za-naplatu-potrazivanja-izrecena-upravna-novcana-kazna-u-iznosu-od-226-milijuna-eura/", lastmod: "2023-05-04" },
    { url: "https://azop.hr/izdana-nova-upravna-novcana-kazna/", lastmod: null },
    { url: "https://azop.hr/izrecene-upravne-novcane-kazne-u-ukupnom-iznosu-od-1-6-milijuna-kuna/", lastmod: "2022-03-08" },
    { url: "https://azop.hr/izrecene-dvije-upravne-novcane-kazne-u-ukupnom-iznosu-218-milijuna-kuna/", lastmod: null },
    { url: "https://azop.hr/izrecena-upravna-novcana-kazna-zbog-nezakonite-obrade-osobnih-podataka/", lastmod: null },
    { url: "https://azop.hr/izrecena-upravna-novcana-kazna-zagrebackom-holdingu/", lastmod: null },
    { url: "https://azop.hr/banci-izrecena-upravna-novcana-kazna-u-iznosu-od-15-milijuna-eura/", lastmod: null },
    { url: "https://azop.hr/teleoperatoru-upravna-novcana-kazna-u-ukupnom-iznosu-od-45-milijuna-eura/", lastmod: null },
    { url: "https://azop.hr/izreceno-osam-upravnih-novcanih-kazni-u-ukupnom-iznosu-od-350-50000-eura/", lastmod: null },
    { url: "https://azop.hr/sankcije-za-prekrsitelje-opce-uredbe-o-zastiti-podataka-i-zakona-o-provedbi-opce-uredbe-o-zastiti-podataka/", lastmod: null },
    { url: "https://azop.hr/rjesenje-kojim-se-izrice-upravno-novcana-kazna-zbog-odbijanja-dostave-osobnih-podataka-ispitanicima/", lastmod: null },
    { url: "https://azop.hr/kriteriji-za-obrocnu-otplatu-i-uvjeti-za-raskid-obrocne-otplate-upravne-novcane-kazne/", lastmod: null },
    // Guidelines and opinions
    { url: "https://azop.hr/smjernice-za-primjenu-opce-uredbe/", lastmod: null },
    { url: "https://azop.hr/vodic-o-obradi-osobnih-podataka-putem-kolacica/", lastmod: null },
    { url: "https://azop.hr/privola-kao-pravni-temelj-za-obradu-osobnih-podataka-zaposlenika/", lastmod: null },
    { url: "https://azop.hr/pravni-temelji-za-obradu-osobnih-podataka/", lastmod: null },
    { url: "https://azop.hr/obrada-osobnih-podataka-o-zdravlju-u-kontekstu-izvanredne-situacije-izazvane-covid-19-virusom/", lastmod: null },
    { url: "https://azop.hr/obrada-osobnih-podataka-ispitanika-od-strane-politickih-stranaka-i-drugih-sudionika-izborne-promidzbe/", lastmod: null },
    { url: "https://azop.hr/obrada-osobnih-podataka-klijenata-u-usluznim-djelatnostima-koje-uvjetuju-fizicki-kontakt-vezano-uz-revitalizaciju-djelatnosti-i-mjere-suzbijanja-virusa-covid-19/", lastmod: null },
    { url: "https://azop.hr/smjernice-europskog-odbora-za-zastitu-podataka-u-kontekstu-covid-19-pandemije/", lastmod: null },
    { url: "https://azop.hr/smjernice-o-kodeksima-ponasanja/", lastmod: null },
    { url: "https://azop.hr/legitiman-interes-kao-pravni-temelj-za-anketiranje-putem-telefona-i-registar-ne-zovi/", lastmod: null },
    { url: "https://azop.hr/obrada-osobnih-podataka-u-svrhu-prijave-za-cijepljenje-putem-portala-cijepise/", lastmod: null },
    { url: "https://azop.hr/uredba-o-umjetnoj-inteligenciji/", lastmod: null },
    { url: "https://azop.hr/savjeti-gradanima-za-postupanje-u-slucaju-sumnje-na-zlouporabu-osobnih-podataka/", lastmod: null },
  ];
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseArgs();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  AZOP Ingestion Crawler                                 ║");
  console.log("║  Source: azop.hr (Agencija za zaštitu osobnih podataka) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Mode: ${cli.dryRun ? "DRY RUN (no DB writes)" : cli.force ? "FORCE (drop + recreate)" : cli.resume ? "RESUME" : "FULL"}`);
  console.log(`  DB path: ${DB_PATH}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms between requests`);
  if (cli.limit) console.log(`  Limit: ${cli.limit} pages`);

  // Load resume state
  const state = cli.resume ? loadState() : { ingested_urls: [], last_run: "" };
  if (cli.resume && state.ingested_urls.length > 0) {
    console.log(`  Resume: ${state.ingested_urls.length} previously ingested URLs`);
  }

  // Init DB (unless dry-run)
  let db: Database.Database | null = null;
  if (!cli.dryRun) {
    db = initDb(cli.force);
    ensureTopics(db);
    console.log(`  Database initialised at ${DB_PATH}`);
  }

  // Phase 1: Discover URLs from sitemaps
  const sitemapEntries = await discoverSitemapUrls();

  // Add supplementary URLs not in sitemap
  const supplementary = getSupplementaryUrls();
  const existingUrls = new Set(sitemapEntries.map((e) => e.url));
  let supplementaryAdded = 0;
  for (const entry of supplementary) {
    if (!existingUrls.has(entry.url)) {
      sitemapEntries.push(entry);
      supplementaryAdded++;
    }
  }
  if (supplementaryAdded > 0) {
    console.log(`  Added ${supplementaryAdded} supplementary URLs not found in sitemap`);
  }

  // Phase 2 & 3: Fetch, parse, insert
  const stats = await ingestPages(sitemapEntries, db, cli, state);

  // Summary
  console.log("\n=== Ingestion Summary ===\n");
  console.log(`  URLs discovered:          ${stats.discovered}`);
  console.log(`  Skipped (pattern):        ${stats.skipped_pattern}`);
  console.log(`  Skipped (resume):         ${stats.skipped_resume}`);
  console.log(`  Decisions inserted:       ${stats.decisions_inserted}`);
  console.log(`  Decisions skipped (dup):  ${stats.decisions_skipped_dup}`);
  console.log(`  Guidelines inserted:      ${stats.guidelines_inserted}`);
  console.log(`  Guidelines skipped (dup): ${stats.guidelines_skipped_dup}`);
  console.log(`  Fetch errors:             ${stats.fetch_errors}`);
  console.log(`  Parse errors:             ${stats.parse_errors}`);

  if (db) {
    const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
    const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
    const topicCount = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
    const ftsDec = (db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }).cnt;
    const ftsGuide = (db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }).cnt;

    console.log(`\n  Database totals:`);
    console.log(`    Topics:     ${topicCount}`);
    console.log(`    Decisions:  ${decisionCount} (FTS: ${ftsDec})`);
    console.log(`    Guidelines: ${guidelineCount} (FTS: ${ftsGuide})`);

    db.close();
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
