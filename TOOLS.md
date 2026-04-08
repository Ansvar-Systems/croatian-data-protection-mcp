# Tools Reference

This MCP server exposes 8 tools under the `hr_dp_` prefix.

## hr_dp_search_decisions

Full-text search across AZOP decisions (rješenja, kazne, upozorenja).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `privola kolačići`, `telekomunikacije`, `povreda podataka`) |
| `type` | string | No | Filter by type: `kazna`, `upozorenje`, `rješenje`, `mišljenje` |
| `topic` | string | No | Filter by topic ID (e.g., `consent`, `cookies`, `transfers`) |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Returns:** `{ results: Decision[], count: number, _meta: Meta }`

---

## hr_dp_get_decision

Get a specific AZOP decision by reference number.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reference` | string | Yes | AZOP decision reference (e.g., `AZOP-2021-1234`, `UP/I-034-04/21-01/123`) |

**Returns:** `Decision | error`

---

## hr_dp_search_guidelines

Search AZOP guidance documents: smjernice, mišljenja, and preporuke.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `procjena učinka`, `kolačići privola`, `videonadzor`) |
| `type` | string | No | Filter by type: `smjernica`, `mišljenje`, `preporuka`, `vodič` |
| `topic` | string | No | Filter by topic ID |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Returns:** `{ results: Guideline[], count: number, _meta: Meta }`

---

## hr_dp_get_guideline

Get a specific AZOP guidance document by its database ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | number | Yes | Guideline database ID (from `hr_dp_search_guidelines` results) |

**Returns:** `Guideline | error`

---

## hr_dp_list_topics

List all covered data protection topics with Croatian and English names.

**Parameters:** none

**Returns:** `{ topics: Topic[], count: number, _meta: Meta }`

---

## hr_dp_list_sources

List all data sources used by this server with provenance metadata.

**Parameters:** none

**Returns:** `{ sources: SourceInfo[], count: number, _meta: Meta }`

Each source includes: `id`, `name`, `authority`, `url`, `jurisdiction`, `type`, `license`, `scope`, `languages`.

---

## hr_dp_check_data_freshness

Check data freshness and record counts for each source.

**Parameters:** none

**Returns:** `{ sources: SourceFreshness[], _meta: Meta }`

Each entry includes: `source_id`, `decisions_count`, `guidelines_count`, `topics_count`, `latest_decision_date`, `latest_guideline_date`, `status` (`ok` | `empty`).

---

## hr_dp_about

Return metadata about this MCP server.

**Parameters:** none

**Returns:** `{ name, version, description, data_source, coverage, tools, _meta }`

---

## _meta Block

All tool responses include a `_meta` block:

```json
{
  "_meta": {
    "server": "croatian-data-protection-mcp",
    "version": "0.1.0",
    "generated_at": "2026-04-05T12:00:00.000Z"
  }
}
```
