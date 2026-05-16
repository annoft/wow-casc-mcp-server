# wow-casc-mcp-server

MCP server for reading World of Warcraft client files via [CASC](https://wowdev.wiki/CASC) storage.

## Tools

| Tool | Description |
|------|-------------|
| `casc_open` | Open CASC storage, returns handleId + buildNumber |
| `casc_find` | Find files by wildcard mask (JS pre-filter, no native iteration) |
| `casc_read` | Read file content (text or base64) |
| `casc_close` | Close storage handle |

## casc_find — JS Pre-Filter

v1.3.0 replaced native `CascFindFirstFile`/`CascFindNextFile` iteration with JS readline streaming. The community listfile (2.1M entries, 139MB) is filtered line-by-line via regex in ~2-5 seconds. Native iteration previously took 3+ minutes.

| Field | Description |
|-------|-------------|
| `method` | `"js-pre-filter"` — confirms JS path |
| `_source` | `"listfile"` — data from CSV, not CASC index |
| `size` | `null` — use `casc_read` for file details |
| `available` | `null` — use `casc_read` for file details |

**Mask matching**: case-insensitive, `*` matches any characters, `?` matches single character.

**Performance**: `< 5s` for full 2.1M entry scan. 60s timeout as safety net.

## casc_open — Build Detection

`casc_open` response includes `buildNumber` (Blizzard's internal build counter). Compare against last known value to detect client changes and invalidate cached CASC data.

## Timeouts

| Operation | Timeout |
|-----------|---------|
| `casc_open` | 30s |
| `casc_find` | 60s |
| `casc_read` | 30s |
| Listfile download | 30s |

## Setup

```bash
npm install
```

### Community Listfile

`casc_find` auto-downloads the latest community listfile on first use — **no manual setup needed**.

**Source**: [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile/releases) — the canonical community listfile, same source used by [wow.tools.local](https://github.com/Marlamin/wow.tools.local).

**How it works**:
- First `casc_find` without `listfilePath` → downloads `community-listfile.csv` to server directory
- Subsequent calls → uses local cache
- Cache older than 1 day → auto re-downloads
- Failed download → falls back to stale cache (if exists), otherwise returns numeric FileDataIds

**Manual override**: Pass `listfilePath` in `casc_find` to use a custom listfile instead.

**Format**: CSV with `FileDataID;filename` lines:
```
1;interface/cinematics/logo_800.avi
53183;sound/music/citymusic/darnassus/darnassus intro.mp3
```

### MCP Config

```json
{
  "mcpServers": {
    "wow-casc": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/mcp-casc/index.js"]
    }
  }
}
```

### Requirements

- Node.js 18+
- World of Warcraft installation (retail)
- `@jamiephan/casclib` and `@modelcontextprotocol/sdk` (installed via npm)

## Version

1.3.0 — JS pre-filter casc_find (2-5s vs 3min), 60s timeout, buildNumber in casc_open response.
