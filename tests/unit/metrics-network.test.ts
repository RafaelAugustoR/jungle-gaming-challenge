import { expect, test } from 'bun:test';
import { isMetricsPeerAllowed, parseMetricsCidr } from '../../src/observability/metrics-network';

test('internal metrics listener accepts only IPv4 peers inside its configured subnet', () => {
  const network = parseMetricsCidr('172.31.20.0/24');
  expect(isMetricsPeerAllowed('172.31.20.8', network)).toBe(true);
  expect(isMetricsPeerAllowed('::ffff:172.31.20.8', network)).toBe(true);
  expect(isMetricsPeerAllowed('172.31.21.8', network)).toBe(false);
  expect(isMetricsPeerAllowed('127.0.0.1', undefined)).toBe(false);
  expect(isMetricsPeerAllowed('::1', network)).toBe(false);
  expect(parseMetricsCidr('172.31.20.0/44')).toBeUndefined();
});
