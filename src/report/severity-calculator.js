const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const SEVERITY_WEIGHT = { critical: 10, warning: 3, info: 1 };

function calculateSeverity(channelResults) {
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  const channelScores = {};

  for (const result of channelResults) {
    const ch = result.channel?.name || result.channel?.id || 'unknown';
    if (!channelScores[ch]) channelScores[ch] = { critical: 0, warning: 0, info: 0, score: 0 };

    for (const f of result.findings) {
      if (f.severity === 'critical') { criticalCount++; channelScores[ch].critical++; }
      else if (f.severity === 'warning') { warningCount++; channelScores[ch].warning++; }
      else { infoCount++; channelScores[ch].info++; }
      channelScores[ch].score += SEVERITY_WEIGHT[f.severity] ?? 0;
    }
    result.findings.sort((a, b) => rank(a) - rank(b));
  }

  // Sort messages by channel score descending, then by worst single finding within a channel
  channelResults.sort((a, b) => {
    const aName = a.channel?.name || a.channel?.id || 'unknown';
    const bName = b.channel?.name || b.channel?.id || 'unknown';
    const scoreDiff = (channelScores[bName]?.score ?? 0) - (channelScores[aName]?.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Math.min(...a.findings.map(rank)) - Math.min(...b.findings.map(rank));
  });

  const rankedChannels = Object.entries(channelScores)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([name, stats]) => ({ name, ...stats }));

  return { criticalCount, warningCount, infoCount, rankedChannels };
}

function rank(finding) {
  return SEVERITY_RANK[finding.severity] ?? 3;
}

module.exports = { calculateSeverity };
