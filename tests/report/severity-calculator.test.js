const { calculateSeverity } = require('../../src/report/severity-calculator');

function makeResult(channel, severities) {
  return {
    channel: { id: 'C1', name: channel },
    message: { ts: '1', user: 'U1', text: 'msg' },
    findings: severities.map(s => ({ type: 'test', severity: s, suggestion: '', wcag: '' })),
  };
}

describe('calculateSeverity', () => {
  test('counts severities correctly', () => {
    const results = [
      makeResult('general', ['critical', 'warning']),
      makeResult('random', ['info', 'info']),
    ];
    const counts = calculateSeverity(results);
    expect(counts).toEqual({ criticalCount: 1, warningCount: 1, infoCount: 2 });
  });

  test('returns zeros for empty results', () => {
    expect(calculateSeverity([])).toEqual({ criticalCount: 0, warningCount: 0, infoCount: 0 });
  });

  test('sorts findings within a result critical-first', () => {
    const result = makeResult('general', ['info', 'critical', 'warning']);
    calculateSeverity([result]);
    expect(result.findings.map(f => f.severity)).toEqual(['critical', 'warning', 'info']);
  });

  test('sorts channel results by worst severity', () => {
    const results = [
      makeResult('info-channel', ['info']),
      makeResult('critical-channel', ['critical']),
      makeResult('warning-channel', ['warning']),
    ];
    calculateSeverity(results);
    expect(results.map(r => r.channel.name)).toEqual([
      'critical-channel',
      'warning-channel',
      'info-channel',
    ]);
  });
});
