import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './jobs.js';
import { readReferenceCatalog, mergeReferenceCatalogs } from '../../shared/catalog.js';

function catalogKey(accountId, target) {
  const scope = JSON.stringify([accountId, target.campusCode, target.sportCode, target.modeCode,
    target.venues.map((venue) => venue.CGBM).sort()]);
  return createHash('sha256').update(scope).digest('hex');
}

// Only reference structure is cached. It can identify a fixed court at release,
// but never establishes a vacancy for salvage or subsequent retries.
export class ReferenceCatalogStore {
  constructor(dataDir) { this.dir = join(dataDir, 'catalogs'); this.pending = new Map(); this.writes = new Map(); }
  async loadCached(key) {
    return readJson(join(this.dir, key + '.json')).catch((error) => {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    });
  }
  async cachedRooms({ accountId = 'default', target }) {
    const cached = await this.loadCached(catalogKey(accountId, target));
    // Strip legacy availability flags as well: this is court identity, not a
    // live view. The shared runner validates identity and the release window.
    return mergeReferenceCatalogs([], { target, cached }).rooms.map((room) => Object.fromEntries(
      ['WID', 'CDMC', 'CGBM', 'CQBM', 'XMDM', 'XQDM']
        .filter((field) => room[field] !== undefined).map((field) => [field, room[field]])));
  }
  async read({ accountId = 'default', ...input }) {
    const target = { ...input.target, courtNames: null };
    const key = catalogKey(accountId, target);
    // A stopped check owns its abort signal; do not let it cancel another check.
    const queryKey = input.signal ? Symbol() : JSON.stringify([key, input.dates, input.times ?? target.times]);
    if (!this.pending.has(queryKey)) {
      const work = (async () => {
        const path = join(this.dir, key + '.json');
        const cached = await this.loadCached(key);
        let catalog = await readReferenceCatalog({ ...input, target, cached,
          deadline: input.deadline === Infinity || input.deadline === undefined ? Date.now() + 45_000 : input.deadline });
        if (catalog.times.length || catalog.courts.length) {
          const commit = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const latest = await readJson(path).catch((error) => {
              if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
              throw error;
            });
            const merged = mergeReferenceCatalogs([catalog], { target, cached: latest });
            catalog = { ...merged, dates: catalog.dates, cached: catalog.cached || merged.cached };
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            await writeJson(path, { date: catalog.date, times: catalog.times,
              courts: catalog.courts.map(({ id, name, venue, venueCode }) => ({ id, name, venue, venueCode })),
              rooms: catalog.rooms.map((room) => Object.fromEntries(['WID', 'CDMC', 'CGBM', 'CQBM', 'XMDM', 'XQDM']
                .filter((field) => room[field] !== undefined).map((field) => [field, room[field]]))) });
          });
          this.writes.set(key, commit);
          try { await commit; } finally { if (this.writes.get(key) === commit) this.writes.delete(key); }
        }
        return catalog;
      })();
      this.pending.set(queryKey, work);
      work.finally(() => this.pending.delete(queryKey)).catch(() => {});
    }
    const catalog = await this.pending.get(queryKey);
    const selected = mergeReferenceCatalogs([catalog], { target: input.target });
    return { ...selected, dates: catalog.dates, cached: catalog.cached, partial: catalog.partial };
  }
}
