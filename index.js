'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const casclib = require('@jamiephan/casclib');
const { randomUUID } = require('crypto');
const { join } = require('path');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { stat, rename, unlink } = require('fs/promises');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');

const { Storage, CascStorageInfoClass } = casclib;

// --- Constants ---
const HANDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes auto-cleanup
const READ_TIMEOUT_MS = 30_000;       // 30s per file read
const FIND_TIMEOUT_MS = 60_000;       // 60s for casc_find (JS pre-filter scans full listfile)
const MAX_TEXT_BYTES  = 100 * 1024;   // 100KB text truncation threshold
const MAX_BIN_BYTES   = 500 * 1024;   // 500KB binary truncation threshold
const LISTFILE_URL    = 'https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv';
const LISTFILE_CACHE  = join(__dirname, 'community-listfile.csv');
const LISTFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// Map<handleId, { storage, timer }>
const handles = new Map();

// Listfile auto-download state: lazy-init, cached across calls
let _listfile_path = null;
let _listfile_ready = false;   // true once first _ensure_listfile has run
let _listfile_error = null;
let _listfile_downloading = null; // Promise | null — dedupe concurrent requests

// --- Helpers ---

function _register_ttl(handleId) {
  if (handles.has(handleId)) {
    const entry = handles.get(handleId);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      try { entry.storage.close(); } catch (_) {}
      handles.delete(handleId);
    }, HANDLE_TTL_MS);
  }
}

function _with_timeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); })
           .catch(e => { clearTimeout(timer); reject(e); });
  });
}

function _is_text(buf, window) {
  return !buf.slice(0, Math.min(window || 512, buf.length)).includes(0x00);
}

function _limit_response(buf, isText) {
  const limit = isText ? MAX_TEXT_BYTES : MAX_BIN_BYTES;
  if (buf.length <= limit) return null; // no truncation needed
  return { truncated: true, fullSize: buf.length, returned: limit };
}

// Convert wildcard mask to case-insensitive regex. Separator '/' not special.
function _wildcard_to_regex(mask) {
  const escaped = mask.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

// Listfile auto-download (lazy, cached). Follows wow.tools.local pattern:
// download latest community-listfile.csv from wowdev/wow-listfile releases.
// Re-download if local copy is older than LISTFILE_MAX_AGE_MS.
async function _ensure_listfile() {
  if (_listfile_ready) return; // already resolved (success or fail)

  // Deduplicate concurrent calls
  if (_listfile_downloading) {
    try { await _listfile_downloading; } catch (_) {}
    return;
  }

  _listfile_downloading = (async () => {
    try {
      // Check local cache — retain _listfile_path so fallback works on download failure
      let stale = true;
      try {
        const s = await stat(LISTFILE_CACHE);
        stale = (Date.now() - s.mtimeMs) > LISTFILE_MAX_AGE_MS;
        if (!stale) {
          _listfile_path = LISTFILE_CACHE;
          return;
        }
        // Cache exists but stale — set path now so error path can fall back to it
        _listfile_path = LISTFILE_CACHE;
      } catch (_) { /* not found, _listfile_path stays null */ }

      // Download from GitHub releases to temp file, validate size, then rename
      const res = await _with_timeout(fetch(LISTFILE_URL, {
        redirect: 'follow',
        headers: { 'User-Agent': 'wow-casc-mcp/1.3.0' }
      }), READ_TIMEOUT_MS);

      if (!res.ok) {
        // Keep stale cache if we have one
        if (_listfile_path) { return; }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const expectedSize = parseInt(res.headers.get('content-length'), 10);
      const tmpPath = LISTFILE_CACHE + '.tmp';

      await pipeline(
        res.body,
        createWriteStream(tmpPath)
      );

      // Validate downloaded size matches Content-Length
      if (expectedSize) {
        const actual = await stat(tmpPath);
        if (actual.size !== expectedSize) {
          await unlink(tmpPath).catch(() => {});
          throw new Error(
            `Downloaded listfile size mismatch: expected ${expectedSize} bytes, got ${actual.size}. ` +
            `Keeping cached listfile.`
          );
        }
      }

      // Atomic rename to final path
      await rename(tmpPath, LISTFILE_CACHE);
      _listfile_path = LISTFILE_CACHE;
    } catch (e) {
      _listfile_error = e.message;
      // Clean up temp file on error
      await unlink(LISTFILE_CACHE + '.tmp').catch(() => {});
      // If stale cache exists, keep using it
      if (_listfile_path) { return; }
      // Otherwise, listfile unavailable
    }
  })();

  try { await _listfile_downloading; } catch (_) {}
  _listfile_ready = true;
}

function _listfile_status() {
  if (_listfile_path) {
    const fresh = `cached at ${_listfile_path}`;
    return { source: 'auto-downloaded', path: _listfile_path, status: 'available', note: fresh };
  }
  if (_listfile_error) {
    return { source: 'auto-download', status: 'unavailable', error: _listfile_error,
             hint: 'Download failed. Provide listfilePath manually or check network.' };
  }
  return { source: 'auto-download', status: 'unknown', hint: 'Listfile not yet resolved.' };
}

// --- Server ---

const server = new Server(
  { name: 'wow-casc', version: '1.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'casc_open',
      description:
        'Open WoW CASC storage. Returns handleId for subsequent calls. ' +
        'storagePath = WoW Data directory, e.g. "D:\\Program Files\\World of Warcraft\\_retail_\\Data". ' +
        'Community listfile auto-downloaded on first casc_find (no manual setup needed). ' +
        'Call casc_close when done, or handle auto-expires after 10 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          storagePath: {
            type: 'string',
            description: 'Absolute path to WoW Data directory (contains "data" subdir with .idx files).'
          }
        },
        required: ['storagePath']
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        title: 'Open WoW CASC storage handle'
      }
    },
    {
      name: 'casc_find',
      description:
        'Find files by wildcard mask. Uses JS pre-filter on community listfile (no native CASC iteration — fast). ' +
        'Community listfile auto-downloaded by default (from wowdev/wow-listfile) — no listfilePath needed. ' +
        'Returns files array + pagination metadata (returned, has_more, total_count). ' +
        'Note: size/available fields are null (listfile-only results). Use casc_read for exact file details.',
      inputSchema: {
        type: 'object',
        properties: {
          handleId:     { type: 'string', description: 'Handle ID from casc_open (required for listfile resolution + TTL refresh).' },
          mask:         { type: 'string', description: 'Wildcard mask, e.g. "*.lua" or "Interface/FrameXML/*.lua". Case-insensitive.' },
          listfilePath: { type: 'string', description: 'Optional path to community-listfile.csv for human-readable names.' },
          maxResults:   { type: 'number', description: 'Max results (default 200, max 1000).' }
        },
        required: ['handleId', 'mask']
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        title: 'Find files in CASC storage by wildcard (JS pre-filter)'
      }
    },
    {
      name: 'casc_read',
      description:
        'Read file from CASC storage by path. Text files (no null bytes) returned as UTF-8 string; ' +
        'binary files returned as base64. Large files are truncated: text >100KB, binary >500KB. ' +
        'If truncated, response includes fullSize and hint to re-read with byte range via casc_read_range.',
      inputSchema: {
        type: 'object',
        properties: {
          handleId: { type: 'string', description: 'Handle ID from casc_open.' },
          filePath: { type: 'string', description: 'CASC file path, e.g. "Interface/FrameXML/UIParent.lua". Use casc_find to discover paths.' }
        },
        required: ['handleId', 'filePath']
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        title: 'Read file from CASC storage'
      }
    },
    {
      name: 'casc_close',
      description:
        'Close CASC storage handle and free memory. Call when done with a handle, ' +
        'or rely on 10-minute auto-expiry.',
      inputSchema: {
        type: 'object',
        properties: {
          handleId: { type: 'string', description: 'Handle ID from casc_open.' }
        },
        required: ['handleId']
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        title: 'Close CASC storage handle'
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    // --- casc_open ---
    if (name === 'casc_open') {
      const storage = new Storage();
      await _with_timeout(
        new Promise((resolve, reject) => {
          try { storage.open(args.storagePath); resolve(); }
          catch (e) { reject(e); }
        }),
        READ_TIMEOUT_MS
      );
      const id = randomUUID();
      const entry = { storage, timer: null };
      handles.set(id, entry);
      _register_ttl(id);
      const localCount = storage.getStorageInfo(CascStorageInfoClass.LocalFileCount);
      const product = storage.getStorageInfo(CascStorageInfoClass.Product);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          handleId: id,
          localFileCount: localCount.fileCount,
          codeName: product.codeName,
          buildNumber: product.buildNumber,
          ttlMinutes: 10,
          listfile: 'auto-downloaded from wowdev/wow-listfile on first casc_find',
          hint: 'Use this handleId with casc_find and casc_read. Call casc_close when done, or handle auto-expires.'
        }) }]
      };
    }

    // --- casc_find (JS pre-filter, async streaming, 60s timeout) ---
    if (name === 'casc_find') {
      return await _with_timeout((async () => {
        const entry = handles.get(args.handleId);
        if (!entry) throw new Error(
          `Unknown handleId: ${args.handleId}. The handle may have expired (TTL: 10 min). Call casc_open first to create a new handle.`
        );
        _register_ttl(args.handleId);

        // Resolve listfile: user-provided > auto-downloaded > none
        let listfilePath = args.listfilePath || '';
        let listfileMeta;
        if (args.listfilePath) {
          listfileMeta = { source: 'user-provided', path: args.listfilePath };
        } else {
          await _ensure_listfile();
          listfileMeta = _listfile_status();
          if (_listfile_path) {
            listfilePath = _listfile_path;
          }
        }

        if (!listfilePath) {
          throw new Error(
            'No listfile available. Provide listfilePath parameter or ensure network access for auto-download. ' +
            'Without a listfile, casc_find cannot resolve file names.'
          );
        }

        const max = Math.min(args.maxResults || 200, 1000);
        const regex = _wildcard_to_regex(args.mask);
        const results = [];
        let totalCount = 0;

        const rl = createInterface({
          input: createReadStream(listfilePath, 'utf8'),
          crlfDelay: Infinity
        });

        for await (const line of rl) {
          const semiIdx = line.indexOf(';');
          if (semiIdx === -1) continue;
          const fileName = line.slice(semiIdx + 1);
          if (regex.test(fileName)) {
            totalCount++;
            if (results.length < max) {
              const fileDataId = parseInt(line.slice(0, semiIdx), 10) || 0;
              results.push({
                name: fileName,
                fileDataId: fileDataId,
                size: null,
                available: null,
                _source: 'listfile'
              });
            }
          }
        }

        const hasMore = totalCount > max;
        return {
          content: [{ type: 'text', text: JSON.stringify({
            returned: results.length,
            total_count: totalCount,
            has_more: hasMore,
            listfile: listfileMeta,
            method: 'js-pre-filter',
            ...(hasMore && {
              hint: `${totalCount - max} more files match. Narrow your mask or increase maxResults (max 1000).`
            }),
            files: results
          }) }]
        };
      })(), FIND_TIMEOUT_MS);
    }

    // --- casc_read ---
    if (name === 'casc_read') {
      const entry = handles.get(args.handleId);
      if (!entry) throw new Error(
        `Unknown handleId: ${args.handleId}. The handle may have expired (TTL: 10 min). Call casc_open first to create a new handle.`
      );
      _register_ttl(args.handleId);
      const storage = entry.storage;

      let file;
      try {
        file = storage.openFile(args.filePath);
      } catch (e) {
        throw new Error(
          `Cannot open file: ${args.filePath}. ` +
          `File may not exist in CASC storage. Use casc_find to verify the path. Error: ${e.message}`
        );
      }

      const buf = await _with_timeout(
        new Promise((resolve, reject) => {
          try { resolve(file.readAll()); } catch (e) { reject(e); }
        }),
        READ_TIMEOUT_MS
      );
      file.close();

      const isText = _is_text(buf);
      const truncation = _limit_response(buf, isText);

      if (isText) {
        let text = buf.toString('utf8');
        if (truncation) {
          text = text.slice(0, truncation.returned);
        }
        const payload = { path: args.filePath, size: buf.length, encoding: 'utf8', text };
        if (truncation) {
          payload.truncated = true;
          payload.fullSize = buf.length;
          payload.hint =
            `File truncated (${buf.length} bytes total, showing first ${truncation.returned} bytes). ` +
            `This is a text file. Use Grep on cached data instead of re-reading, or request specific sections.`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }

      // Binary
      const b64 = buf.toString('base64');
      const payload = { path: args.filePath, size: buf.length, encoding: 'base64' };
      if (truncation) {
        payload.data = b64.slice(0, Math.floor(truncation.returned * 4 / 3));
        payload.truncated = true;
        payload.fullSize = buf.length;
        payload.hint =
          `Binary file truncated (${buf.length} bytes total). ` +
          `For large binary files, consider if you really need the full content.`;
      } else {
        payload.data = b64;
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    // --- casc_close ---
    if (name === 'casc_close') {
      const entry = handles.get(args.handleId);
      if (!entry) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            closed: false,
            note: `Handle ${args.handleId} not found. It may have already expired or been closed.`
          }) }]
        };
      }
      clearTimeout(entry.timer);
      entry.storage.close();
      handles.delete(args.handleId);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          closed: true,
          handleId: args.handleId
        }) }]
      };
    }

    throw new Error(
      `Unknown tool: ${name}. Available tools: casc_open, casc_find, casc_read, casc_close.`
    );
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { process.stderr.write(`Fatal: ${err.message}\n`); process.exit(1); });
