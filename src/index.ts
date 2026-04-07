#!/usr/bin/env node

/**
 * Croatian Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying AZOP decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: hr_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "croatian-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "hr_dp_search_decisions",
    description:
      "Full-text search across AZOP decisions (rješenja, kazne, upozorenja). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'privola kolačići', 'telekomunikacije', 'povreda podataka')",
        },
        type: {
          type: "string",
          enum: ["kazna", "upozorenje", "rješenje", "mišljenje"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'transfers'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
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
        reference: {
          type: "string",
          description: "AZOP decision reference (e.g., 'AZOP-2021-1234', 'UP/I-034-04/21-01/123')",
        },
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
        query: {
          type: "string",
          description: "Search query (e.g., 'procjena učinka', 'kolačići privola', 'videonadzor')",
        },
        type: {
          type: "string",
          enum: ["smjernica", "mišljenje", "preporuka", "vodič"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'dpia', 'cookies', 'breach_notification'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hr_dp_get_guideline",
    description:
      "Get a specific AZOP guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from hr_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "hr_dp_list_topics",
    description:
      "List all covered data protection topics with Croatian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hr_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
        return textContent({
          ...(typeof decision === 'object' ? decision : { data: decision }),
          _citation: buildCitation(
            (decision as any).reference || parsed.reference,
            (decision as any).title || (decision as any).subject || '',
            'hr_dp_get_decision',
            { reference: parsed.reference },
            (decision as any).url || null,
          ),
        });
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
        return textContent({
          ...(typeof guideline === 'object' ? guideline : { data: guideline }),
          _citation: buildCitation(
            (guideline as any).reference || String(parsed.id),
            (guideline as any).title || (guideline as any).subject || '',
            'hr_dp_get_guideline',
            { id: String(parsed.id) },
            (guideline as any).url || null,
          ),
        });
      }

      case "hr_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
