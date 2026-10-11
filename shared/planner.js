import { MODE_CODES } from './constants.js';
import { projectForTarget } from './projects.js';

function exactList(value) {
  if (!value || value.length === 0 || value.includes('*')) return null;
  return value;
}

function includesSport(venue, code) {
  return String(venue.XM).split(',').includes(code);
}

// School order rows sometimes identify a court only by its display name. Use a
// saved label only when there is no ID; a known, different ID wins over a name.
export function matchesCourtSelection(target, room) {
  if (!room || (!room.WID && (!room.CDMC || room.CDMC === '学校已约场地'))) return false;
  if (room.CGBM && target.venues?.length && !target.venues.some((venue) => String(venue.CGBM) === String(room.CGBM))) return false;
  if (room.XQDM && target.campusCode && String(room.XQDM) !== String(target.campusCode)) return false;
  if (room.YYLX && target.modeCode && Number(room.YYLX) !== Number(target.modeCode)) return false;
  return !target.courtNames || target.includeOtherCourts === true
    || target.courtNames.some((court) => court === room.WID || court === room.CDMC
      || (!room.WID && target.courtLabels?.[court] === room.CDMC));
}

export function resolveTargets(config, metadata) {
  const enabled = config.targets.filter((target) => target.enabled !== false);
  if (enabled.length === 0) throw new Error('没有启用的预约目标');

  return enabled.map((target, targetIndex) => {
    const campus = metadata.campusList.find(
      (item) => item.XQDM === String(target.campus) || item.XQDM_DISPLAY === target.campus,
    );
    if (!campus) throw new Error(`[${target.name}] 找不到校区：${target.campus}`);

    const sport = metadata.xmList.find(
      (item) => item.XQDM === campus.XQDM
        && (item.XMDM === String(target.sport) || item.XMMC === target.sport),
    );
    if (!sport) throw new Error(`[${target.name}] ${campus.XQDM_DISPLAY}没有项目：${target.sport}`);

    const modeCode = MODE_CODES[target.mode];
    if (!String(sport.DCFS ?? '').split(',').includes(modeCode)) {
      throw new Error(`[${target.name}] ${sport.XMMC}不支持${target.mode}`);
    }

    const source = modeCode === '1.0' ? metadata.packageVenueList : metadata.dismissalVenueList;
    const availableVenues = source.filter(
      (venue) => venue.SSXQ === campus.XQDM && includesSport(venue, sport.XMDM),
    );
    const requestedVenues = exactList(target.venues);
    const venues = requestedVenues
      ? requestedVenues.map((name) => {
          const venue = availableVenues.find(
            (item) => item.CGBM === String(name) || item.CGMC === name,
          );
          if (!venue) throw new Error(`[${target.name}] 找不到场馆：${name}`);
          return venue;
        })
      : availableVenues;
    if (venues.length === 0) throw new Error(`[${target.name}] 没有匹配的场馆`);

    const project = projectForTarget(target);
    const configuredCourts = target.courts ?? config.courtPreferences?.[project?.id]
      ?? config.courtPreferences?.[target.sport]
      ?? ['*'];

    return {
      ...target,
      targetIndex,
      campusCode: campus.XQDM,
      campusName: campus.XQDM_DISPLAY,
      sportCode: sport.XMDM,
      sportName: sport.XMMC,
      modeCode,
      modeName: modeCode === '1.0' ? '包场' : '散场',
      venues,
      projectId: project?.id ?? target.project,
      courtNames: exactList(configuredCourts),
    };
  });
}

export function buildQueryGroups(targets, date) {
  const groups = [];
  for (const target of targets) {
    target.times.forEach((time, timeIndex) => {
      target.venues.forEach((venue, venueIndex) => {
        groups.push({
          target,
          date,
          time,
          timeIndex,
          venue,
          venueIndex,
          key: [target.campusCode, target.sportCode, target.modeCode, date, time, venue.CGBM].join('|'),
        });
      });
    });
  }
  return groups;
}

export function roomsToTasks(group, rooms) {
  const requested = group.target.courtNames;
  return rooms
    .filter((room) => room.CGBM === group.venue.CGBM)
    .filter((room) => !requested || group.target.includeOtherCourts === true || requested.includes(room.CDMC) || requested.includes(room.WID))
    .map((room, rowIndex) => {
      const configuredIndex = requested
        ? Math.min(...[room.CDMC, room.WID].map((name) => {
            const index = requested.indexOf(name);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
          }))
        : rowIndex;
      return {
        ...group,
        room,
        available: !room.disabled,
        priority: [
          group.target.targetIndex,
          group.timeIndex,
          group.venueIndex,
          configuredIndex,
          rowIndex,
        ],
        taskId: [group.target.name, group.date, group.time, room.CGBM, room.WID].join('|'),
      };
    });
}

export function compareTasks(left, right) {
  for (let i = 0; i < left.priority.length; i += 1) {
    if (left.priority[i] !== right.priority[i]) return left.priority[i] - right.priority[i];
  }
  return left.taskId.localeCompare(right.taskId, 'zh-CN');
}
