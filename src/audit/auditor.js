const Anthropic = require('@anthropic-ai/sdk');
const { callMcpTool } = require('../slack/client');

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MESSAGE_LIMIT = Math.min(parseInt(process.env.AUDIT_MESSAGE_LIMIT || '200', 10), 100);
const IMAGE_SIZE_LIMIT = 4 * 1024 * 1024; // 4 MB — stay under Claude's 5 MB per-image limit

const SLACK_TOOLS = [
  {
    name: 'slack_read_channel',
    description: 'Reads messages from a Slack channel in reverse chronological order (newest first). Returns formatted message text including file attachments.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel ID to read' },
        limit: { type: 'integer', description: 'Messages to return, 1-100. Default 100.' },
        cursor: { type: 'string', description: 'Pagination cursor for the next page' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'slack_read_thread',
    description: 'Reads all replies in a Slack thread.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel ID' },
        message_ts: { type: 'string', description: 'Timestamp of the parent message' },
        limit: { type: 'integer', description: 'Replies to return, 1-1000. Default 100.' },
      },
      required: ['channel_id', 'message_ts'],
    },
  },
  {
    name: 'fetch_slack_image',
    description: 'Fetches a Slack image file by its private URL and returns the image for visual analysis. Use this whenever you find an image file in a message to determine whether it conveys information that needs alt-text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The url_private of the Slack image file' },
      },
      required: ['url'],
    },
  },
];

const SYSTEM_PROMPT = `You are an accessibility auditor for Slack channels. When given a channel to audit:

1. Read the channel messages using slack_read_channel (use limit: ${MESSAGE_LIMIT})
2. For EVERY message that has thread replies (indicated by reply counts, "> N replies", or thread markers in the channel output), you MUST call slack_read_thread with that message's timestamp to fetch and audit all replies — thread content is equally subject to accessibility violations
3. For every image file found in a message, call fetch_slack_image with its url_private to visually inspect it
4. Analyze every message for WCAG 2.1/ADA violations:

   Links (WCAG 2.4.4): bare URLs not wrapped in descriptive text; generic anchor text ("click here", "here", "link", "read more"); URL shorteners (bit.ly, tinyurl, etc.)
   Emoji (WCAG 1.3.3/1.4.1): more than 3 emoji total; emoji-only messages with no text; color/status emoji (🟢🔴🟡 or :large_green_circle:) used without a text label; 3+ consecutive lines starting with an emoji bullet
   Color-only (WCAG 1.4.1): "the red items", "green rows", "click the blue button" — color as the sole differentiator
   ALL CAPS (WCAG 1.3.3): 4+ consecutive all-caps words making up ≥30% of the message
   Clarity (usability): unclear pronouns without a clear referent; unexplained jargon or acronyms; visual-only instructions ("see the chart on the left", "the highlighted row"); message longer than 500 chars with no line breaks
   Vague standalone messages: for every top-level channel message (NOT a thread reply) that is fewer than 15 words, ask yourself "could someone reading only this message know WHAT was done/changed, and WHERE/to which system/item?" — if the answer to either is NO, flag it as type "vague-context-free", severity "warning"; the suggestion must ask the author to add the missing who/what/where detail (e.g. "Specify what was deployed and to which environment")
   Images (WCAG 1.1.1): check the "[Image file accessibility metadata]" appended to the slack_read_channel result — it lists every image and its alt-text status. Only flag meaningful images (charts, screenshots, diagrams, photos) — not decorative ones (solid color, simple icons):
     • Alt-text IS set — you MUST visually compare it against the actual image content:
         – Accurate and adequately descriptive → do NOT flag
         – Describes something unrelated to or contradicting the actual image (e.g. alt-text says "bar chart" but image is a photo of a dog) → type "image-misleading-alt-text", severity "critical"; quote the alt-text and briefly describe what the image actually shows; misleading alt-text is worse than none because it actively misinforms screen reader users
         – Present but clearly inadequate (just the filename, "image", "photo", a single word, or a vague generic phrase) → type "image-poor-alt-text", severity "warning"; quote the existing alt-text in context
     • NO alt-text set AND no descriptive companion text in the message → type "image-no-alt-text", severity "critical"
     • Filename looks auto-generated or non-descriptive (e.g. "1_XjTCoBcq_xi1Ad60WabLog.png", "IMG_1234.png", "image001.png", "screenshot_20240101.png", names with random alphanumeric sequences, camelCase gibberish, or underscores+numbers) → ALSO add a separate issue: type "image-noisy-filename", severity "warning", suggestion "Rename the file to a human-readable name (e.g. 'architecture-diagram.png') before sharing — screen readers announce the filename alongside the alt-text, so a cryptic name adds unnecessary noise"
   Documents (WCAG 1.1.1/1.2.x): check the "[Document file accessibility metadata]" appended to the slack_read_channel result:
     • Document has no extractable text → type "document-no-text", severity "critical", suggest sharing a plain-text alternative or accessible version
     • PDF/doc shared with no companion text in the message AND no extractable text → also flag as "document-no-alt"
     • Video with no caption or transcript mention → type "video-no-caption", severity "critical"
     • Audio with no transcript mention → type "audio-no-transcript", severity "critical"

5. After reading and analyzing all content, return ONLY a JSON object — no surrounding text:
{
  "findings": [
    {
      "message_text": "first 80 chars of the offending message",
      "message_ts": "slack timestamp string",
      "user": "user id",
      "issues": [
        {
          "type": "short-slug",
          "severity": "critical|warning|info",
          "context": "brief excerpt or description ≤80 chars",
          "suggestion": "actionable fix ≤200 chars",
          "wcag": "criterion number or empty string"
        }
      ]
    }
  ]
}

Only include messages that have at least one issue. Return {"findings":[]} if the channel is fully accessible.`;

async function fetchSlackImageForClaude(url) {
  // Look up alt-text from Slack files.info using the file ID embedded in the URL.
  // Slack private URLs embed the file ID after a hyphen: /files-pri/TXXXXX-FXXXXX/name.png
  // so we search for the F-prefixed ID anywhere in the URL, not just after a slash.
  let altText = null;
  const fileIdMatch = url.match(/(F[A-Z0-9]{6,})/i);
  console.log(`[image] url=${url} fileId=${fileIdMatch?.[1] ?? 'not-found'}`);
  if (fileIdMatch) {
    try {
      // User token typically has broader files:read access than the bot token
      const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
      const infoRes = await fetch(`https://slack.com/api/files.info?file=${fileIdMatch[1]}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const info = await infoRes.json();
      console.log(`[image] files.info ok=${info.ok} alt_text=${JSON.stringify(info)}`);
      altText = info.file?.alt_txt || info.file?.alt_text || null;
    } catch (err) {
      console.log(`[image] files.info error: ${err.message}`);
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > IMAGE_SIZE_LIMIT) {
    throw new Error(`Image too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB) — skipping`);
  }

  const mediaType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const base64 = Buffer.from(buffer).toString('base64');

  const altTextNote = altText
    ? `This image has alt-text set: "${altText}". Compare this alt-text against what you actually see in the image — is it accurate? Does it describe the right content, or does it describe something unrelated or incorrect?`
    : 'This image has no alt-text set.';

  return [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
    { type: 'text', text: `Analyze this image for accessibility. ${altTextNote} Does the image convey meaningful information? If so, evaluate the alt-text for both accuracy (does it describe THIS image?) and adequacy (is it descriptive enough for a screen reader user?).` },
  ];
}

const DOC_TYPES = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'txt', 'rtf', 'pages', 'numbers', 'keynote']);

async function fetchChannelFileMetadata(channelId) {
  try {
    const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN;
    const res = await fetch(`https://slack.com/api/files.list?channel=${channelId}&count=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok || !data.files?.length) return '';

    const sections = [];

    const imageFiles = data.files.filter(f => f.mimetype?.startsWith('image/'));
    if (imageFiles.length) {
      const notes = imageFiles.map(f => {
        const alt = f.alt_txt || f.alt_text;
        return alt
          ? `  • "${f.name}" (${f.id}): alt-text is SET — "${alt}"`
          : `  • "${f.name}" (${f.id}): NO alt-text set`;
      });
      sections.push('[Image file accessibility metadata — use this to determine alt-text status]\n' + notes.join('\n'));
    }

    const docFiles = data.files.filter(f => DOC_TYPES.has(f.filetype?.toLowerCase()));
    if (docFiles.length) {
      const notes = docFiles.map(f => {
        const hasText = f.plain_text || f.preview;
        return hasText
          ? `  • "${f.name}" (${f.filetype?.toUpperCase()}): has extractable text — document is readable`
          : `  • "${f.name}" (${f.filetype?.toUpperCase()}): no extractable text found — may be inaccessible to screen readers`;
      });
      sections.push('[Document file accessibility metadata — use this to check document accessibility]\n' + notes.join('\n'));
    }

    if (!sections.length) return '';
    console.log(`[metadata] channel=${channelId} images=${imageFiles.length} docs=${docFiles.length}`);
    return '\n\n' + sections.join('\n\n');
  } catch (err) {
    console.log(`[files] metadata lookup failed: ${err.message}`);
    return '';
  }
}

async function auditChannelWithClaude(channelId, channelName) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages = [{
    role: 'user',
    content: `Audit the Slack channel "#${channelName}" (channel ID: ${channelId}) for accessibility violations. Read the messages then return your findings as JSON.`,
  }];

  for (let round = 0; round < 10; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: SLACK_TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const raw = textBlock?.text || '{"findings":[]}';
      try {
        const json = raw.match(/\{[\s\S]*\}/)?.[0] || '{"findings":[]}';
        const parsed = JSON.parse(json);
        return normalizeFindings(parsed.findings || [], channelId, channelName);
      } catch {
        return [];
      }
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async block => {
            console.log(`[tool] Claude calling ${block.name}`, JSON.stringify(block.input));
            try {
              if (block.name === 'fetch_slack_image') {
                const content = await fetchSlackImageForClaude(block.input.url);
                return { type: 'tool_result', tool_use_id: block.id, content };
              }
              let content = await callMcpTool(block.name, block.input);
              if (block.name === 'slack_read_channel') {
                const fileMeta = await fetchChannelFileMetadata(block.input.channel_id);
                console.log(`[metadata] channel=${block.input.channel_id} appended=${!!fileMeta} length=${fileMeta.length}`);
                if (fileMeta) content += fileMeta;
              }
              return { type: 'tool_result', tool_use_id: block.id, content };
            } catch (err) {
              return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}` };
            }
          })
      );

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  return [];
}

function normalizeFindings(findings, channelId, channelName) {
  return findings
    .map(f => ({
      channel: { id: channelId, name: channelName },
      message: { ts: f.message_ts, user: f.user, text: String(f.message_text || '').slice(0, 100) },
      findings: (f.issues || []).map(issue => ({
        type: String(issue.type || 'unknown').slice(0, 40),
        severity: ['critical', 'warning', 'info'].includes(issue.severity) ? issue.severity : 'info',
        context: String(issue.context || '').slice(0, 120),
        suggestion: String(issue.suggestion || '').slice(0, 250),
        wcag: String(issue.wcag || ''),
      })),
    }))
    .filter(r => r.findings.length > 0);
}

function checkChannelMetadata(channelId, channelName, channelData) {
  const findings = [];

  const purpose = channelData?.purpose?.value?.trim() || '';
  const topic = channelData?.topic?.value?.trim() || '';

  if (!purpose) {
    findings.push({
      type: 'missing-channel-description',
      severity: 'warning',
      context: 'Channel has no description (purpose) set',
      suggestion: "Add a channel description via Channel Settings → Edit so screen readers and newcomers understand the channel's purpose without having to scroll through messages.",
      wcag: '2.4.6',
    });
  }

  if (!topic) {
    findings.push({
      type: 'missing-channel-topic',
      severity: 'info',
      context: 'Channel has no topic set',
      suggestion: 'Set a channel topic to provide current context (e.g. active sprint, incident, or team focus) — helps users orient quickly without reading message history.',
      wcag: '',
    });
  }

  if (findings.length === 0) return [];

  return [{
    channel: { id: channelId, name: channelName },
    message: { ts: 'channel-meta', user: '', text: 'Channel metadata' },
    findings,
  }];
}

module.exports = { auditChannelWithClaude, checkChannelMetadata };
