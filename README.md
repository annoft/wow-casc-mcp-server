# wow-casc-mcp-server

MCP server for reading World of Warcraft client files via [CASC](https://wowdev.wiki/CASC) storage.

## Tools

| Tool | Description |
|------|-------------|
| `casc_open` | Open CASC storage, returns handleId |
| `casc_find` | Find files by wildcard mask |
| `casc_read` | Read file content (text or base64) |
| `casc_close` | Close storage handle |

## Setup

```bash
npm install
```

### Community Listfile

`casc_find` needs a community listfile to resolve human-readable file names.
Without it, files return as numeric FileDataIds (e.g., `12345` instead of `Interface/FrameXML/UIParent.lua`).

**Source**: [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile/releases) — the canonical community listfile, also used by [wow.tools.local](https://github.com/Marlamin/wow.tools.local).

**Format**: CSV with `FileDataID;filename` lines:
```
1;interface/cinematics/logo_800.avi
53183;sound/music/citymusic/darnassus/darnassus intro.mp3
```

**Setup**:
1. Download `community-listfile.csv` from the [latest release](https://github.com/wowdev/wow-listfile/releases)
2. Save to this directory
3. Pass `listfilePath` parameter to `casc_find`

**Updates**: New WoW patches add/rename files. Re-download periodically to keep lookups current.
The listfile release is updated by the community as new files are identified.

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

1.1.0 — Response size limits, pagination metadata, handle TTL, tool annotations.
