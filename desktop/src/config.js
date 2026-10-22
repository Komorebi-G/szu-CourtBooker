import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG_FILE, MODE_CODES } from '../../shared/constants.js';
import { validateBookingGoal } from '../../shared/booking-goal.js';
import { releaseEpoch, resolveDate, splitTimeSlot } from '../../shared/utils.js';
import { atomicWrite } from './atomic-file.js';

const defaults = {
  scheduler: {
    releaseTime: '12:30:00',
    targetDate: 'tomorrow',
    pollIntervalMs: 80,
    pollJitterMs: 0,
    timeoutMs: 20_000,
    queryConcurrency: 6,
    heartbeatMinutes: 5,
  },
  booking: { taskConcurrency: 4 },
};

function positiveNumber(value, path, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${path} 必须是${allowZero ? '非负' : '正'}数`);
  }
}

export async function loadConfig(path = DEFAULT_CONFIG_FILE) {
  const source = await readFile(path, 'utf8');
  const raw = YAML.parse(source) ?? {};
  const config = {
    scheduler: { ...defaults.scheduler, ...(raw.scheduler ?? {}) },
    booking: { ...defaults.booking, ...(raw.booking ?? {}) },
    courtPreferences: raw.courtPreferences ?? {},
    targets: raw.targets ?? [],
  };

  delete config.scheduler.earlyStartMs;
  config.scheduler.releaseTime = '12:30:00';
  config.booking = { taskConcurrency: config.booking.taskConcurrency };
  return validateConfig(config);
}

export function validateConfig(config) {
  releaseEpoch('2026-01-01', config.scheduler.releaseTime);
  resolveDate(config.scheduler.targetDate);
  positiveNumber(config.scheduler.heartbeatMinutes, 'scheduler.heartbeatMinutes');
  positiveNumber(config.scheduler.pollIntervalMs, 'scheduler.pollIntervalMs');
  positiveNumber(config.scheduler.pollJitterMs, 'scheduler.pollJitterMs', { allowZero: true });
  positiveNumber(config.scheduler.timeoutMs, 'scheduler.timeoutMs');
  positiveNumber(config.scheduler.queryConcurrency, 'scheduler.queryConcurrency');
  positiveNumber(config.booking.taskConcurrency, 'booking.taskConcurrency');
  for (const [key, value] of Object.entries({ queryConcurrency: config.scheduler.queryConcurrency,
    taskConcurrency: config.booking.taskConcurrency })) {
    if (!Number.isInteger(value)) throw new Error(`${key} 必须为整数`);
  }

  if (!Array.isArray(config.targets)) throw new Error('config.yaml 的 targets 必须是数组');
  if (!config.courtPreferences || typeof config.courtPreferences !== 'object') {
    throw new Error('courtPreferences 必须是对象');
  }
  for (const [project, courts] of Object.entries(config.courtPreferences)) {
    if (!Array.isArray(courts)) throw new Error(`courtPreferences.${project} 必须是数组`);
  }

  config.targets.forEach((target, index) => {
    if (target.date) resolveDate(target.date);
    if (target.preferSameCourt !== undefined && typeof target.preferSameCourt !== 'boolean') throw new Error('优先同一场地必须为开关值');
    if (target.includeOtherCourts !== undefined && typeof target.includeOtherCourts !== 'boolean') throw new Error('其余场地选项必须为开关值');
    const prefix = `targets[${index}]`;
    for (const key of ['name', 'campus', 'sport', 'mode']) {
      if (!target[key]) throw new Error(`${prefix}.${key} 不能为空`);
    }
    if (!MODE_CODES[target.mode]) throw new Error(`${prefix}.mode 只支持“包场”或“散场”`);
    if (!Array.isArray(target.times) || target.times.length === 0) {
      throw new Error(`${prefix}.times 至少需要一个时间段`);
    }
    target.times.forEach(splitTimeSlot);
    validateBookingGoal(target);
    for (const key of ['venues', 'courts']) {
      if (target[key] !== undefined && !Array.isArray(target[key])) {
        throw new Error(`${prefix}.${key} 必须是数组`);
      }
    }
    if (target.courts && (target.courts.length === 0 || target.courts.some((court) => typeof court !== 'string' || !court.trim()))) {
      throw new Error(`${prefix}.courts 至少选择一个场地，或使用 * 表示全部`);
    }
  });

  return config;
}

export async function saveConfig(config, path = DEFAULT_CONFIG_FILE) {
  validateConfig(config);
  const absolute = resolve(path);
  const source = YAML.stringify(config, { lineWidth: 0 });
  await atomicWrite(absolute, source);
}
