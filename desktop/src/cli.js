#!/usr/bin/env node
import { DEFAULT_CONFIG_FILE, DEFAULT_SESSION_FILE } from '../../shared/constants.js';
import { SzuVenueApi } from '../../shared/api.js';
import { loadConfig } from './config.js';
import { HttpClient } from './http-client.js';
import { buildQueryGroups, resolveTargets, roomsToTasks } from '../../shared/planner.js';
import { defaultTargetDate, runBooking } from '../../shared/runner.js';
import { importSessionFromCdp } from './session.js';
import { createLogger, mapLimit, resolveDate } from '../../shared/utils.js';

const log = createLogger();

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) flags[rawName] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[rawName] = argv[++index];
    else flags[rawName] = true;
  }
  return { positional, flags };
}

function usage() {
  console.log(`用法：
  node src/cli.js session import-edge [--session .session.json]
  node src/cli.js session check
  node src/cli.js catalog [--config config.yaml] [--date tomorrow]
  node src/cli.js run [--config config.yaml] [--date tomorrow] [--now]
  node src/cli.js orders [--limit 20]
  node src/cli.js cancel <预约记录WID>

说明：run 只检查配置，不下单。正式预约请在 Web UI 手动开始本次执行，所有任务共用请求队列。`);
}

async function createApi(sessionPath) {
  const client = await HttpClient.create({ sessionPath });
  return { client, api: new SzuVenueApi(client) };
}

async function sessionCommand(action, sessionPath) {
  if (action === 'import-edge') {
    const result = await importSessionFromCdp(sessionPath);
    log('OK', '登录态已安全导入', result);
    return;
  }
  if (action === 'check') {
    const { client, api } = await createApi(sessionPath);
    const identity = await api.getIdentity();
    const dates = await api.getAvailableDates();
    await client.flush();
    log('OK', '登录态有效', { user: identity.name, availableDates: dates });
    return;
  }
  throw new Error(`未知 session 子命令：${action ?? ''}`);
}

async function catalogCommand({ configPath, sessionPath, dateValue }) {
  const config = await loadConfig(configPath);
  const { client, api } = await createApi(sessionPath);
  const metadata = await api.getSportVenueData();
  const targets = resolveTargets(config, metadata);
  const date = resolveDate(dateValue ?? defaultTargetDate(config));
  const groups = buildQueryGroups(targets, date);
  const rows = (await mapLimit(groups, config.scheduler.queryConcurrency, async (group) => {
    const rooms = await api.getOpeningRooms({
      campusCode: group.target.campusCode,
      sportCode: group.target.sportCode,
      modeCode: group.target.modeCode,
      venueCode: group.venue.CGBM,
      date,
      time: group.time,
    });
    return roomsToTasks(group, rooms);
  })).flat();

  for (const task of rows) {
    const state = task.available ? '可预约' : task.room.text || '不可预约';
    console.log([
      task.target.name,
      task.target.campusName,
      task.venue.CGMC,
      task.room.CDMC,
      task.time,
      state,
    ].join(' | '));
  }
  await client.flush();
  log('INFO', '场地清单完成', { date, tasks: rows.length });
}

async function runCommand({ configPath, sessionPath, dateValue, immediate, live }) {
  if (live) throw new Error('正式预约请通过 Web UI 手动开始本次执行，避免绕过统一执行器产生重复请求');
  const config = await loadConfig(configPath);
  const { client, api } = await createApi(sessionPath);
  const identity = await api.getIdentity();
  const metadata = await api.getSportVenueData();
  const targets = resolveTargets(config, metadata);
  const date = resolveDate(dateValue ?? defaultTargetDate(config));
  log('INFO', '登录态和配置检查通过', {
    user: identity.name,
    targets: targets.map((target) => target.name),
  });
  const result = await runBooking({ api, client, config, targets, date, immediate, live, log });
  if (!result.ok) process.exitCode = 2;
}

async function ordersCommand(sessionPath, limit) {
  const { client, api } = await createApi(sessionPath);
  const data = await api.getBookings({ pageSize: limit });
  for (const row of data.rows) {
    console.log([
      row.WID,
      row.DHID,
      row.YYZT_DISPLAY,
      row.XMDM_DISPLAY,
      row.CGDM_DISPLAY,
      row.CDWID_DISPLAY,
      row.YYSJD,
    ].join(' | '));
  }
  await client.flush();
}

async function cancelCommand(sessionPath, wid) {
  if (!wid) throw new Error('cancel 需要“我的预约”记录的 WID，可先运行 orders 查询');
  const { client, api } = await createApi(sessionPath);
  const response = await api.cancelBooking(wid);
  if (response.code !== '0') throw new Error(response.msg || '取消失败');
  await client.flush();
  log('OK', '预约已取消', { wid });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, subcommand] = positional;
  const configPath = flags.config || DEFAULT_CONFIG_FILE;
  const sessionPath = flags.session || DEFAULT_SESSION_FILE;

  if (!command || command === 'help' || flags.help) return usage();
  if (command === 'session') return sessionCommand(subcommand, sessionPath);
  if (command === 'catalog') {
    return catalogCommand({ configPath, sessionPath, dateValue: flags.date });
  }
  if (command === 'run') {
    return runCommand({
      configPath,
      sessionPath,
      dateValue: flags.date,
      immediate: Boolean(flags.now),
      live: Boolean(flags.live),
    });
  }
  if (command === 'orders') return ordersCommand(sessionPath, Number(flags.limit || 20));
  if (command === 'cancel') return cancelCommand(sessionPath, subcommand);
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  log('ERROR', error.message);
  process.exitCode = 1;
});
