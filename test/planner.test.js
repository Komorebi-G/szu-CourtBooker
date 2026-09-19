import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueryGroups, compareTasks, resolveTargets, roomsToTasks } from '../shared/planner.js';

const metadata = {
  campusList: [{ XQDM: '1', XQDM_DISPLAY: '粤海校区' }],
  xmList: [{ XQDM: '1', XMDM: '001', XMMC: '羽毛球', DCFS: '1.0' }],
  packageVenueList: [{ SSXQ: '1', XM: '001', CGBM: '001', CGMC: '东馆' }],
  dismissalVenueList: [],
};

test('按中文名称解析目标并展开查询组', () => {
  const config = {
    targets: [{
      name: '测试', enabled: true, campus: '粤海校区', sport: '羽毛球', mode: '包场',
      venues: ['东馆'], courts: ['2号场', '1号场'], times: ['19:00-20:00', '20:00-21:00'],
    }],
  };
  const targets = resolveTargets(config, metadata);
  const groups = buildQueryGroups(targets, '2026-09-20');
  assert.equal(groups.length, 2);
  assert.equal(targets[0].sportCode, '001');
  assert.equal(targets[0].modeCode, '1.0');
});

test('场地任务遵循配置中的场地优先级', () => {
  const [target] = resolveTargets({
    targets: [{
      name: '测试', enabled: true, campus: '粤海校区', sport: '羽毛球', mode: '包场',
      venues: ['东馆'], courts: ['2号场', '1号场'], times: ['19:00-20:00'],
    }],
  }, metadata);
  const [group] = buildQueryGroups([target], '2026-09-20');
  const tasks = roomsToTasks(group, [
    { WID: 'a', CGBM: '001', CDMC: '1号场', disabled: false },
    { WID: 'b', CGBM: '001', CDMC: '2号场', disabled: false },
  ]).sort(compareTasks);
  assert.deepEqual(tasks.map((task) => task.room.CDMC), ['2号场', '1号场']);
});

test('任务自己的场地选择不受项目旧偏好影响', () => {
  const [target] = resolveTargets({
    courtPreferences: { badminton: ['2号场', '1号场'] },
    targets: [{
      name: '测试', project: 'badminton', enabled: true, campus: '粤海校区', sport: '羽毛球', mode: '包场',
      venues: ['东馆'], courts: ['1号场'], times: ['19:00-20:00'],
    }],
  }, metadata);
  const [group] = buildQueryGroups([target], '2026-09-20');
  const tasks = roomsToTasks(group, [
    { WID: 'a', CGBM: '001', CDMC: '1号场', disabled: false },
    { WID: 'b', CGBM: '001', CDMC: '2号场', disabled: false },
  ]).sort(compareTasks);
  assert.deepEqual(tasks.map((task) => task.room.CDMC), ['1号场']);
});
