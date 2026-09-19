import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, releaseEpoch, resolveDate, splitTimeSlot } from '../shared/utils.js';

test('日期与时段解析', () => {
  assert.equal(addDays('2026-09-19', 1), '2026-09-20');
  assert.equal(resolveDate('2026-09-20'), '2026-09-20');
  assert.deepEqual(splitTimeSlot('19:00-20:00'), { start: '19:00', end: '20:00' });
  assert.equal(releaseEpoch('2026-09-19', '12:30:00'), Date.parse('2026-09-19T12:30:00+08:00'));
});
