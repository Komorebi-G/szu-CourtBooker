export const RECOVERY_GRACE_MS = 30 * 60_000;
export const withinRecoveryWindow = (job, now = Date.now()) => now <= job.releaseAt + RECOVERY_GRACE_MS;

// Only reconcile the exact request interrupted by a crash. This is not a
// cross-task conflict check: previous unrelated/cancelled orders never block.
export async function reconcilePending(api, pending) {
  const matches = [];
  let page = 1, read = 0;
  while (page <= 100) {
    const data = await api.getBookings({ pageNumber: page++, pageSize: 100 });
    if (!Array.isArray(data.rows)) throw new Error('学校预约记录格式异常，无法确认中断请求');
    for (const row of data.rows) {
      const range = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?\s*[~～]\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(row.YYSJD ?? '');
      if (!range || range[1] !== pending.date || range[3] !== pending.date || `${range[2]}-${range[4]}` !== pending.time) continue;
      if (String(row.CDWID) !== String(pending.room.WID) || String(row.XMDM) !== String(pending.room.XMDM)) continue;
      // Cancelled/unknown states are deliberately NOT treated as a new success.
      if (!['待支付', '待付款', '已预约', '预约成功', '已支付', '已完成', '待核销', '已核销'].includes(row.YYZT_DISPLAY)) continue;
      if (!row.DHID) continue;
      matches.push(row);
    }
    read += data.rows.length;
    if (!data.rows.length || read >= Number(data.totalSize) || data.rows.length < 100) break;
  }
  if (matches.length !== 1) return null;
  const row = matches[0];
  return { date: pending.date, time: pending.time, court: pending.room.CDMC,
    room: pending.room, orderId: row.DHID, reconciled: true };
}
