export const freshState = () => ({ version: 1, accounts: [], plans: [], runs: [], catalogs: {} });
export class MobileStore {
  constructor(device) { this.device = device; this.state = freshState(); this.pending = Promise.resolve(); }
  async load() {
    const { value } = await this.device.readState();
    if (value) {
      const data = JSON.parse(value);
      if (data.version !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.plans) || !Array.isArray(data.runs)) {
        throw new Error('本地数据格式异常，已停止加载以免覆盖原数据');
      }
      this.state = { ...freshState(), ...data };
      for (const run of this.state.runs) if (!run.finishedAt) {
        run.status = 'interrupted'; run.error = '上次执行已中断，未自动重跑。请先核对学校预约，再执行剩余时段。';
        run.finishedAt = new Date().toISOString();
        for (const item of run.items ?? []) if (['preparing', 'waiting', 'booking', 'stopping'].includes(item.status)) {
          item.status = 'interrupted'; item.error = run.error;
        }
      }
      await this.save();
    }
    return this.state;
  }
  save() {
    const value = JSON.stringify(this.state);
    const work = this.pending.catch(() => {}).then(() => this.device.writeState({ value }));
    this.pending = work; return work;
  }
}
