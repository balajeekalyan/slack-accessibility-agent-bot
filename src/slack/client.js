const MCP_ENDPOINT = 'https://mcp.slack.com/mcp';

let _requestId = 0;
let _sessionId = null;
let _ready = false;

// --- MCP transport ---

async function mcpRequest(method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`,
    Accept: 'application/json, text/event-stream',
    ...(_sessionId && { 'Mcp-Session-Id': _sessionId }),
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_requestId, method, params }),
  });

  if (res.headers.has('mcp-session-id')) {
    _sessionId = res.headers.get('mcp-session-id');
  }

  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);

  const ct = res.headers.get('content-type') || '';
  const json = ct.includes('text/event-stream')
    ? await readSseStream(res)
    : await res.json();

  if (json.error) throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

// Reads an SSE stream line-by-line and returns on the first JSON-RPC response.
// Avoids the hang caused by awaiting res.text() on a persistent SSE connection.
async function readSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete final line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          // Skip notifications (no id); return on the first actual response
          if (parsed.id !== undefined) {
            reader.cancel().catch(() => {});
            return parsed;
          }
        } catch {}
      }
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }

  throw new Error('SSE stream ended without a JSON-RPC response');
}

async function mcpNotify(method, params = {}) {
  await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`,
      ...(_sessionId && { 'Mcp-Session-Id': _sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  }).catch(() => {});
}

async function ensureReady() {
  if (_ready) return;
  await mcpRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'accessibility-audit-agent', version: '1.0.0' },
  });
  await mcpNotify('notifications/initialized');
  _ready = true;

  const { tools } = await mcpRequest('tools/list');
  console.log('[mcp] Connected. Available tools:', tools.map(t => t.name).join(', '));
}

// Proxies a Claude tool call to the Slack MCP server and returns the raw text
// for Claude to read — we never parse this ourselves.
async function callMcpTool(name, args = {}) {
  await ensureReady();
  const result = await mcpRequest('tools/call', { name, arguments: args });
  const block = result?.content?.find(c => c.type === 'text');
  if (!block) throw new Error(`MCP tool "${name}" returned no text block`);
  return block.text;
}

// --- Public API ---

const RESULTS_CHANNEL_NAME = process.env.AUDIT_RESULTS_CHANNEL || 'accessibility-audit-results';

async function findAuditResultsChannel(slackClient) {
  let cursor;
  do {
    const result = await slackClient.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor && { cursor }),
    });
    const found = (result.channels || []).find(c => c.name === RESULTS_CHANNEL_NAME);
    if (found) return found;
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}


async function fetchAllChannels(slackClient) {
  const member = [];
  const notMember = [];
  let cursor;
  do {
    const result = await slackClient.conversations.list({
      types: 'public_channel,private_channel,mpim',
      exclude_archived: true,
      limit: 200,
      ...(cursor && { cursor }),
    });
    for (const c of result.channels || []) {
      if (c.name === RESULTS_CHANNEL_NAME) continue;
      (c.is_member ? member : notMember).push(c);
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
  return { member, notMember };
}

async function postReport(slackClient, channelId, blocks) {
  await slackClient.chat.postMessage({
    channel: channelId,
    blocks,
    text: 'Accessibility Audit Report',
  });
}

async function uploadReport(slackClient, channelId, content, filename, contentType = 'text/plain') {
  const bytes = Buffer.from(content, 'utf8');

  const { upload_url, file_id } = await slackClient.files.getUploadURLExternal({
    filename,
    length: bytes.length,
  });

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const uploadRes = await fetch(upload_url, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error(`Slack file upload failed: HTTP ${uploadRes.status}`);

  await slackClient.files.completeUploadExternal({
    files: [{ id: file_id, title: 'Accessibility Audit Report' }],
    channel_id: channelId,
  });
}

module.exports = { callMcpTool, fetchAllChannels, postReport, uploadReport, findAuditResultsChannel, RESULTS_CHANNEL_NAME };
