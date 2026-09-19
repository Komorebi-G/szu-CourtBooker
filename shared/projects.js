export const PROJECTS = Object.freeze([
  {
    id: 'badminton',
    label: '羽毛球',
    sport: '羽毛球',
    campus: '粤海校区',
    mode: '包场',
    venues: ['运动广场东馆羽毛球场'],
  },
  {
    id: 'volleyball',
    label: '排球',
    sport: '排球',
    campus: '粤海校区',
    mode: '包场',
    venues: ['西馆排球场（包场）'],
  },
  {
    id: 'gym-floor-1',
    label: '一楼健身房',
    sport: '一楼重量型健身',
    campus: '粤海校区',
    mode: '散场',
    venues: ['运动广场西馆一楼健身房'],
  },
  {
    id: 'gym-floor-2',
    label: '二楼有氧',
    sport: '二楼有氧健身',
    campus: '粤海校区',
    mode: '散场',
    venues: ['运动广场西馆二楼健身房'],
  },
]);

export function getProject(id) {
  return PROJECTS.find((project) => project.id === id);
}

export function projectForTarget(target) {
  return getProject(target.project)
    ?? PROJECTS.find((project) => project.sport === target.sport)
    ?? null;
}
