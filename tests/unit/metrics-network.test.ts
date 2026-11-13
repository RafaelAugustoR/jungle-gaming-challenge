import { expect, test } from 'bun:test';
import { isMetricsPeerAllowed } from '../../src/observability/metrics-network';

test('internal metrics listener accepts only IPv4 peers inside its configured subnet', () => {
  expect(isMetricsPeerAllowed('172.31.20.8', '172.31.20.0/24')).toBe(true);
  expect(isMetricsPeerAllowed('::ffff:172.31.20.8', '172.31.20.0/24')).toBe(true);
  expect(isMetricsPeerAllowed('172.31.21.8', '172.31.20.0/24')).toBe(false);
  expect(isMetricsPeerAllowed('127.0.0.1', '')).toBe(false);
  expect(isMetricsPeerAllowed('::1', '172.31.20.0/24')).toBe(false);
});
