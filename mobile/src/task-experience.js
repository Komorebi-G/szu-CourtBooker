import { planExperience } from '../../shared/experience.js';

// A saved task remains the task to run again. Results never create another plan.
export function mobileTaskExperience(plan, { run, ...options } = {}) {
  const state = planExperience(plan, { ...options, run });
  const outcome = run?.reviewedOutcome ?? run?.status;
  const finished = run && run.mode !== 'check' && !state.active;
  const successes = run?.successes?.length ?? 0;
  let primary = 'start', action = '开始预约', badge = '未开始', hint = state.hint;
  if (state.active) { primary = 'results'; action = '查看进度'; badge = '预约中'; }
  else if (state.pending) {
    primary = 'results'; action = '查看结果'; badge = '结果未确认';
    hint = '上次请求未收到明确结果，在记录中查看。';
  } else if (state.expired) { primary = 'copy'; action = '换日期再约'; badge = '已过期'; }
  else if (state.phase === 'done') { primary = 'results'; action = '查看结果'; badge = '已完成'; hint = '已约到所需时段。'; }
  else if (state.phase === 'login') { primary = 'login'; action = '登录账号'; badge = '需登录'; }
  else if (state.phase === 'future') { action = '开放当天可开始'; badge = '待开放'; }
  else if (outcome === 'corrupt') { primary = 'results'; action = '查看结果'; badge = '记录异常'; }
  else if (finished) {
    badge = successes ? '部分成功' : ({ error: '预约未完成', interrupted: '已中断', stopped: '已停止',
      no_result: '未约到', missed: '已错过', limited: '已达上限' })[outcome] ?? '未完成';
    action = successes ? '继续预约' : '重新预约';
    hint = successes ? `已约到 ${successes} 段，继续尝试其余时段。` : '本次已结束，可查看记录或重新预约。';
  }
  return { ...state, primary, action, badge, hint,
    phase: finished && !state.pending && state.phase === 'attention' && outcome !== 'corrupt' ? 'ready' : state.phase,
    canStart: state.canStart && primary === 'start' };
}
