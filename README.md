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

`casc_find` needs a community listfile to resolve human-readable file names. Without it, files return as numeric FileDataIds.

1. Download the latest community listfile (e.g., from [wow.tools](https://wow.tools/files/#listfile) or [WowDev.wiki](https://wowdev.wiki/))
2. Save as `community-listfile.csv` in this directory
3. Pass `listfilePath` parameter to `casc_find`

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
