const SEVERITY_EMOJI = { critical: '🔴', warning: '🟡', info: 'ℹ️' };
const TYPE_LABEL = {
  'missing-alt-text': 'Image missing alt-text',
  'animated-image-risk': 'Potentially animated image',
  'bare-url': 'Bare URL',
  'generic-link-text': 'Generic link text',
  'shortened-url': 'Opaque shortened URL',
  'excessive-emoji': 'Excessive emoji',
  'emoji-only-status': 'Emoji-only status',
  'emoji-as-bullets': 'Emoji used as list markers',
  'color-only-communication': 'Color-only communication',
  'long-unformatted-message': 'Unformatted long message',
  'excessive-caps': 'Excessive all-caps text',
  'clarity-issue': 'Clarity issue',
  'pdf-no-description': 'PDF without description',
  'document-no-description': 'Document without description',
  'video-no-captions': 'Video without captions',
  'audio-no-transcript': 'Audio without transcript',
  'missing-channel-description': 'Missing channel description',
  'missing-channel-topic': 'Missing channel topic',
};

function formatReport(channelResults, { criticalCount, warningCount, infoCount, rankedChannels = [] }, skipped = [], audited = [], noAccess = []) {
  const totalIssues = criticalCount + warningCount + infoCount;
  const blocks = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '✅ Accessibility Audit Complete', emoji: true },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: totalIssues === 0
        ? '*No accessibility issues found.* 🎉'
        : `*${totalIssues} issue${totalIssues !== 1 ? 's' : ''} found across ${channelResults.length} message${channelResults.length !== 1 ? 's' : ''}*\n🔴 ${criticalCount} critical  •  🟡 ${warningCount} warnings  •  ℹ️ ${infoCount} info`,
    },
  });

  if (totalIssues > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: criticalCount > 0
          ? `*➡️ Next Steps:* Fix the ${criticalCount} critical issue${criticalCount !== 1 ? 's' : ''} first (WCAG Level A violations), then address warnings.\n📄 Full findings attached below.`
          : '*➡️ Next Steps:* Address warnings to improve accessibility for all users.\n📄 Full findings attached below.',
      },
    });
  }

  appendChannelOverview(blocks, rankedChannels, audited, skipped, noAccess);

  return blocks;
}

function buildDetailedHtml(channelResults, { criticalCount, warningCount, infoCount, rankedChannels = [] }, skipped = [], audited = [], noAccess = []) {
  const totalIssues = criticalCount + warningCount + infoCount;
  const date = new Date().toUTCString();

  const withIssues = new Set(rankedChannels.map(c => c.name));
  const clean = audited.filter(name => !withIssues.has(name));
  const resultsChannelSkipped = skipped.filter(s => s.reason === 'results_channel');
  const notInvited = skipped.filter(s => s.reason === 'not_invited');
  const errored = skipped.filter(s => s.reason !== 'not_invited' && s.reason !== 'results_channel');

  // --- channel overview list ---
  const overviewItems = [];
  if (withIssues.size > 0) overviewItems.push(`<li class="has-issues">⚠️ <strong>Issues found (${withIssues.size}):</strong> ${[...withIssues].map(n => esc(channelLabel(n))).join(', ')}</li>`);
  if (clean.length > 0) overviewItems.push(`<li class="clean">✅ <strong>No issues (${clean.length}):</strong> ${clean.map(n => esc(channelLabel(n))).join(', ')}</li>`);
  if (resultsChannelSkipped.length > 0) overviewItems.push(`<li class="skipped">⏭ <strong>Skipped (${resultsChannelSkipped.length}):</strong> ${resultsChannelSkipped.map(s => esc(channelLabel(s.name))).join(', ')} — results channel</li>`);
  if (notInvited.length > 0) overviewItems.push(`<li class="skipped">🚫 <strong>Not invited (${notInvited.length}):</strong> ${notInvited.map(s => esc(channelLabel(s.name))).join(', ')}</li>`);
  if (errored.length > 0) overviewItems.push(`<li class="skipped">⚠️ <strong>Errored (${errored.length}):</strong> ${errored.map(s => esc(channelLabel(s.name))).join(', ')}</li>`);
  if (noAccess.length > 0) overviewItems.push(`<li class="skipped">🔒 <strong>No access (${noAccess.length}):</strong> ${noAccess.map(n => esc(channelLabel(n))).join(', ')}</li>`);

  // --- per-channel findings ---
  let findingsHtml = '';
  if (totalIssues > 0) {
    const grouped = groupByChannel(channelResults);
    const orderedChannels = rankedChannels.length > 0
      ? rankedChannels.map(c => ({ channelName: c.name, results: grouped[c.name] || [], stats: c }))
      : Object.entries(grouped).map(([name, results]) => ({ channelName: name, results, stats: null }));

    for (const { channelName, results, stats } of orderedChannels) {
      if (!results.length) continue;

      const statSpan = stats
        ? `<span class="channel-stats">🔴 ${stats.critical} critical &nbsp;🟡 ${stats.warning} warnings &nbsp;ℹ️ ${stats.info} info</span>`
        : '';

      let messagesHtml = '';
      for (const result of results) {
        const isChannelMeta = result.message?.ts === 'channel-meta';
        const messageHtml = isChannelMeta
          ? `<div class="message-label channel-level">Channel-level issue</div>`
          : (() => {
              const text = result.message?.text || '';
              const preview = text ? text.slice(0, 120) + (text.length > 120 ? '…' : '') : '(no text)';
              return `<div class="message-preview">${esc(preview)}</div>`;
            })();

        let issuesHtml = '';
        for (const finding of result.findings) {
          const label = TYPE_LABEL[finding.type] || finding.type;
          const wcag = finding.wcag && finding.wcag !== 'usability'
            ? `<span class="wcag-badge">WCAG ${esc(finding.wcag)}</span>`
            : '';
          issuesHtml += `
            <div class="finding ${esc(finding.severity)}">
              <div class="finding-header">
                <span class="severity-badge ${esc(finding.severity)}">${esc(finding.severity.toUpperCase())}</span>
                <span class="finding-type">${esc(label)}</span>
                ${wcag}
              </div>
              ${finding.context ? `<p class="finding-context">${esc(finding.context)}</p>` : ''}
              <p class="finding-suggestion">💡 ${esc(finding.suggestion)}</p>
            </div>`;
        }

        messagesHtml += `<div class="message-block">${messageHtml}${issuesHtml}</div>`;
      }

      findingsHtml += `
        <section class="channel-section">
          <details>
            <summary class="channel-name">${esc(channelLabel(channelName))} ${statSpan}</summary>
            <div class="channel-body">${messagesHtml}</div>
          </details>
        </section>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Accessibility Audit Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #111827; background: #f9fafb; padding: 32px 16px; }
  .container { max-width: 860px; margin: 0 auto; }

  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 28px; }

  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
  .card h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }

  .counts { display: flex; gap: 28px; flex-wrap: wrap; }
  .count-item { display: flex; align-items: baseline; gap: 8px; }
  .count-num { font-size: 28px; font-weight: 700; }
  .count-num.critical { color: #dc2626; }
  .count-num.warning  { color: #d97706; }
  .count-num.info     { color: #2563eb; }
  .count-label        { font-size: 13px; color: #6b7280; }
  .clean-msg { color: #16a34a; font-weight: 600; font-size: 15px; }

  .overview-list { list-style: none; display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
  .overview-list li.clean     { color: #16a34a; }
  .overview-list li.has-issues { color: #92400e; }
  .overview-list li.skipped   { color: #6b7280; }

  .channel-section { margin-bottom: 12px; }
  details { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  details[open] { box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .channel-name { font-size: 15px; font-weight: 700; list-style: none; padding: 14px 16px; cursor: pointer; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; user-select: none; }
  .channel-name::-webkit-details-marker { display: none; }
  .channel-name::before { content: '▶'; font-size: 10px; color: #9ca3af; transition: transform .18s; flex-shrink: 0; }
  details[open] > .channel-name::before { transform: rotate(90deg); }
  .channel-name:hover { background: #f9fafb; }
  .channel-stats { font-size: 12px; font-weight: 400; color: #6b7280; margin-left: auto; }
  .channel-body { padding: 12px 14px 14px; border-top: 1px solid #e5e7eb; }

  .message-block { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .message-block:last-child { margin-bottom: 0; }
  .message-preview { font-size: 12px; color: #374151; background: #f3f4f6; padding: 9px 14px; border-bottom: 1px solid #e5e7eb; font-family: 'SFMono-Regular', Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .message-label { font-size: 12px; background: #f3f4f6; padding: 8px 14px; border-bottom: 1px solid #e5e7eb; color: #6b7280; }
  .channel-level { font-style: italic; }

  .finding { padding: 11px 14px; border-left: 4px solid transparent; border-bottom: 1px solid #e5e7eb; }
  .finding:last-child { border-bottom: none; }
  .finding.critical { border-left-color: #dc2626; background: #fef2f2; }
  .finding.warning  { border-left-color: #d97706; background: #fffbeb; }
  .finding.info     { border-left-color: #2563eb; background: #eff6ff; }

  .finding-header { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
  .severity-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.04em; }
  .severity-badge.critical { background: #dc2626; color: #fff; }
  .severity-badge.warning  { background: #d97706; color: #fff; }
  .severity-badge.info     { background: #2563eb; color: #fff; }
  .finding-type { font-weight: 600; font-size: 13px; }
  .wcag-badge { font-size: 10px; background: #e5e7eb; color: #374151; padding: 2px 6px; border-radius: 4px; }

  .finding-context    { font-size: 12px; color: #4b5563; font-style: italic; margin-bottom: 3px; }
  .finding-suggestion { font-size: 13px; color: #374151; }

  .no-issues { text-align: center; padding: 40px; color: #16a34a; font-size: 16px; font-weight: 600; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
</style>
</head>
<body>
<div class="container">

  <h1>Accessibility Audit Report</h1>
  <p class="meta">Generated: ${esc(date)}</p>

  <div class="card">
    <h2>Summary</h2>
    ${totalIssues === 0
      ? `<p class="clean-msg">✅ No accessibility issues found. All audited channels are clean.</p>`
      : `<div class="counts">
           <div class="count-item"><span class="count-num critical">${criticalCount}</span><span class="count-label">Critical</span></div>
           <div class="count-item"><span class="count-num warning">${warningCount}</span><span class="count-label">Warnings</span></div>
           <div class="count-item"><span class="count-num info">${infoCount}</span><span class="count-label">Info</span></div>
         </div>`
    }
  </div>

  ${overviewItems.length > 0 ? `
  <div class="card">
    <h2>Channel Overview</h2>
    <ul class="overview-list">${overviewItems.join('')}</ul>
  </div>` : ''}

  ${totalIssues > 0 ? findingsHtml : '<div class="no-issues">✅ No accessibility issues found.</div>'}

</div>
</body>
</html>`;
}

function channelLabel(name) {
  if (name.startsWith('mpdm-')) {
    const inner = name.replace(/^mpdm-/, '').replace(/-\d+$/, '');
    return `Group DM: ${inner.split('--').filter(Boolean).join(', ')}`;
  }
  return `#${name}`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function appendChannelOverview(blocks, rankedChannels, audited, skipped, noAccess) {
  if (audited.length === 0 && skipped.length === 0 && noAccess.length === 0) return;

  const withIssues = new Set(rankedChannels.map(c => c.name));
  const clean = audited.filter(name => !withIssues.has(name));
  const resultsChannelSkipped = skipped.filter(s => s.reason === 'results_channel');
  const notInvited = skipped.filter(s => s.reason === 'not_invited');
  const errored = skipped.filter(s => s.reason !== 'not_invited' && s.reason !== 'results_channel');

  const lines = [];
  if (withIssues.size > 0) lines.push(`⚠️ *Issues found (${withIssues.size}):* ${[...withIssues].map(n => channelLabel(n)).join(', ')}`);
  if (clean.length > 0) lines.push(`✅ *No issues (${clean.length}):* ${clean.map(n => channelLabel(n)).join(', ')}`);
  if (resultsChannelSkipped.length > 0) lines.push(`:skip: *Skipped (${resultsChannelSkipped.length}):* ${resultsChannelSkipped.map(s => channelLabel(s.name)).join(', ')} — results channel`);
  if (notInvited.length > 0) lines.push(`:no_entry_sign: *Not invited (${notInvited.length}):* ${notInvited.map(s => channelLabel(s.name)).join(', ')} — run \`/invite @<bot>\` to include`);
  if (errored.length > 0) lines.push(`:warning: *Errored (${errored.length}):* ${errored.map(s => channelLabel(s.name)).join(', ')}`);
  if (noAccess.length > 0) lines.push(`:lock: *No access (${noAccess.length}):* ${noAccess.map(n => channelLabel(n)).join(', ')} — bot is not a member`);

  if (lines.length === 0) return;

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: lines.join('\n') }],
  });
}

function groupByChannel(channelResults) {
  const grouped = {};
  for (const result of channelResults) {
    const key = result.channel?.name || result.channel?.id || 'unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(result);
  }
  return grouped;
}

module.exports = { formatReport, buildDetailedHtml };
