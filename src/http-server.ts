#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  listSources,
  checkDataFreshness,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "croatian-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "hr_dp_search_decisions",
    description:
      "Full-text search across AZOP decisions (rješenja, kazne, upozorenja). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'privola kolačići', 'telekomunikacije', 'povreda podataka')" },
        type: {
          type: "string",
          enum: ["kazna", "upozorenje", "rješenje", "mišljenje"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID (e.g., 'consent', 'cookies', 'transfers'). Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "hr_dp_get_decision",
    description:
      "Get a specific AZOP decision by reference number (e.g., 'AZOP-2021-1234', 'UP/I-034-04/21-01/123').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "AZOP decision reference (e.g., 'AZOP-2021-1234', 'UP/I-034-04/21-01/123')" },
      },
      required: ["reference"],
    },
  },
  {
    name: "hr_dp_search_guidelines",
    description:
      "Search AZOP guidance documents: smjernice, mišljenja, and preporuke. Covers GDPR implementation, procjena učinka na zaštitu podataka (DPIA), cookie consent, video surveillance, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'procjena učinka', 'kolačići privola', 'videonadzor')" },
        type: {
          type: "string",
          enum: ["smjernica", "mišljenje", "preporuka", "vodič"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID (e.g., 'dpia', 'cookies', 'breach_notification'). Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "hr_dp_get_guideline",
    description: "Get a specific AZOP guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID (from hr_dp_search_guidelines results)" },
      },
      required: ["id"],
    },
  },
  {
    name: "hr_dp_list_topics",
    description: "List all covered data protection topics with Croatian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hr_dp_list_sources",
    description: "List all data sources used by this server with provenance metadata: authority name, URL, jurisdiction, license, and coverage scope.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hr_dp_check_data_freshness",
    description: "Check data freshness for each source. Reports record counts, latest dates, and staleness status. Use before relying on results to verify data currency.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "hr_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["kazna", "upozorenje", "rješenje", "mišljenje"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["smjernica", "mišljenje", "preporuka", "vodič"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function meta() {
      return {
        server: SERVER_NAME,
        version: pkgVersion,
        generated_at: new Date().toISOString(),
      };
    }

    function textContent(data: unknown) {
      const payload =
        typeof data === "object" && data !== null
          ? { ...(data as Record<string, unknown>), _meta: meta() }
          : { data, _meta: meta() };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "hr_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "hr_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`);
          }
          return textContent(decision);
        }

        case "hr_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "hr_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`);
          }
          return textContent(guideline);
        }

        case "hr_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length });
        }

        case "hr_dp_list_sources": {
          const sources = listSources();
          return textContent({ sources, count: sources.length });
        }

        case "hr_dp_check_data_freshness": {
          const freshness = checkDataFreshness();
          return textContent({ sources: freshness });
        }

        case "hr_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "AZOP (Agencija za zaštitu osobnih podataka) MCP server. Provides access to Croatian data protection authority decisions, sanctions, upozorenja, and official guidance documents.",
            data_source: "AZOP (https://azop.hr/)",
            coverage: {
              decisions: "AZOP rješenja, kazne, and upozorenja",
              guidelines: "AZOP smjernice, mišljenja, and preporuke",
              topics: "Consent (privola), cookies (kolačići), transfers, DPIA (procjena učinka), breach notification, privacy by design, video surveillance (videonadzor), health data, children",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      // Reentrancy guard: mcpServer.close() can synchronously re-fire
      // transport.onclose through the SDK, which would re-enter this handler
      // and recurse until the stack overflows ("RangeError: Maximum call
      // stack size exceeded" observed in prod logs). Also chain to the SDK's
      // internal _onclose wrapper (set by mcpServer.connect) to preserve its
      // cleanup of _responseHandlers, _progressHandlers, and in-flight aborts.
      const sdkOnClose = transport.onclose;
      let closing = false;
      transport.onclose = () => {
        if (closing) return;
        closing = true;
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
        sdkOnClose?.();
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
