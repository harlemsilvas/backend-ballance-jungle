import { expect,test } from 'bun:test';
import { PrometheusTelemetry } from '../../src/infrastructure/observability/telemetry';
test('JSON log fields are filtered and mandatory identifiers are always present',() => {
  const lines: string[]=[]; const telemetry=new PrometheusTelemetry(line => lines.push(line));
  telemetry.event('committed',{ correlationId: 'corr',messageId: 'msg',transactionId: 'tx',walletId: 'wallet',providerId: 'provider',
    amount: '25.00',balance: '75.00',payload: { password: 'secret' },sql: 'select private',token: 'secret' });
  const row=JSON.parse(lines[0]!); expect(row).toMatchObject({ correlationId: 'corr',messageId: 'msg',transactionId: 'tx',walletId: 'wallet',providerId: 'provider' });
  expect(lines[0]).not.toContain('25.00'); expect(lines[0]).not.toContain('secret'); expect(lines[0]).not.toContain('sql');
  telemetry.event('idle'); expect(JSON.parse(lines[1]!).messageId).toBeNull();
});
test('metric labels have fixed cardinality and reject wallet/provider IDs',() => {
  const telemetry=new PrometheusTelemetry(() => {});
  expect(() => telemetry.count('wager_duplicates_total',{ walletId: 'uuid' })).toThrow('INVALID_METRIC_SERIES');
  expect(() => telemetry.count('wager_duplicates_total',{ layer: 'uuid' })).toThrow('INVALID_METRIC_SERIES');
  expect(() => telemetry.count('arbitrary_counter')).toThrow('INVALID_COUNTER');
});
test('histograms are cumulative and include sum/count/+Inf',() => {
  const telemetry=new PrometheusTelemetry(() => {});
  telemetry.observe('wager_processing_duration_seconds',0.02,{ operation: 'process' });
  telemetry.observe('wager_processing_duration_seconds',0.5,{ operation: 'process' });
  const text=telemetry.render();
  expect(text).toContain('wager_processing_duration_seconds_bucket{operation="process",le="0.025"} 1');
  expect(text).toContain('wager_processing_duration_seconds_bucket{operation="process",le="0.5"} 2');
  expect(text).toContain('wager_processing_duration_seconds_bucket{operation="process",le="+Inf"} 2');
  expect(text).toContain('wager_processing_duration_seconds_count{operation="process"} 2');
});
test('invalid metric numbers and decreasing counters are rejected',() => {
  const telemetry=new PrometheusTelemetry(() => {});
  expect(() => telemetry.count('wager_wallets_opened_total',{},-1)).toThrow();
  expect(() => telemetry.gauge('wager_outbox_lag_seconds',Infinity)).toThrow();
  expect(() => telemetry.observe('wager_wallet_lock_wait_seconds',NaN)).toThrow();
});
test('logging sink failure never propagates to financial processing',() => {
  const telemetry=new PrometheusTelemetry(() => { throw new Error('LOG_SINK_DOWN'); });
  expect(() => telemetry.event('committed')).not.toThrow();
});
