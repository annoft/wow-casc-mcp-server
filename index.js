'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const casclib = require('@jamiephan/casclib');
const { randomUUID } = require('crypto');

const { Storage, CascStorageInfoClass } = casclib;

// --- Constants ---
const HANDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes auto-cleanup
const READ_TIMEOUT_MS = 30_000;       // 30s per file read
const MAX_TEXT_BYTES  = 100 * 1024;   // 100KB text truncation threshold
const MAX_BIN_BYTES   = 500 * 1024;   // 500KB binary truncation threshold

// Map<handleId, { storage, timer }>
const handles = new Map();

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

// --- Server ---

const server = new Server(
  { name: 'wow-casc', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'casc_open',
      description:
        'Open WoW CASC storage. Returns handleId for subsequent calls. ' +
        'storagePath = WoW Data directory, e.g. "D:\\Program Files\\World of Warcraft\\_retail_\\Data". ' +
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
        'Find files by wildcard mask. Without listfilePath, WoW files return as numeric FileDataIds. ' +
        'With listfilePath (community-listfile.csv), returns human-readable names. ' +
        'Returns files array + pagination metadata (returned, has_more, total_count_hint).',
      inputSchema: {
        type: 'object',
        properties: {
          handleId:     { type: 'string', description: 'Handle ID from casc_open.' },
          mask:         { type: 'string', description: 'Wildcard mask, e.g. "*.lua" or "Interface/FrameXML/*.lua".' },
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
        title: 'Find files in CASC storage by wildcard'
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
          hint: 'Use this handleId with casc_find and casc_read. Call casc_close when done, or handle auto-expires.'
        }) }]
      };
    }

    // --- casc_find ---
    if (name === 'casc_find') {
      const entry = handles.get(args.handleId);
      if (!entry) throw new Error(
        `Unknown handleId: ${args.handleId}. The handle may have expired (TTL: 10 min). Call casc_open first to create a new handle.`
      );
      _register_ttl(args.handleId);
      const storage = entry.storage;
      const max = Math.min(args.maxResults || 200, 1000);
      const results = [];
      let totalCount = 0;
      let entry_iter = storage.findFirstFile(args.mask, args.listfilePath || '');
      while (entry_iter) {
        totalCount++;
        if (results.length < max) {
          results.push({
            name: entry_iter.fileName,
            fileDataId: entry_iter.fileDataId,
            size: entry_iter.fileSize,
            available: entry_iter.available
          });
        }
        entry_iter = storage.findNextFile();
      }
      storage.findClose();
      const hasMore = totalCount > max;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          returned: results.length,
          total_count: totalCount,
          has_more: hasMore,
          ...(hasMore && {
            hint: `${totalCount - max} more files match. Narrow your mask or increase maxResults (max 1000).`
          }),
          files: results
        }) }]
      };
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
