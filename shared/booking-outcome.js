// Do not infer school meanings from undocumented numeric error codes.
// Unknown, explicit rejections stop with the original reason instead of looping.
export function classifyBookingResponse(response) {
  if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
    throw new Error('预约接口未返回明确业务结果，结果待确认，请核对学校“我的预约”');
  }
  if (response.code === '0') return { kind: 'success' };
  if (response.code === 'LOCAL_DAILY_LIMIT') return { kind: 'limited' };
  if (response.code === 'LOCAL_ACCOUNT_STOPPED') return { kind: 'account', message: response.msg };
  if (response.code === 'SLOT_EXPIRED') return { kind: 'expired', message: response.msg };
  if (response.code === 'EXPIRED') return { kind: 'deadline', message: response.msg };
  const message = typeof response.msg === 'string' ? response.msg : '';
  if (/登录|身份认证|未支付|未付款|待支付|待付款|欠费|黑名单|账号.*(限制|冻结)|账户.*(限制|冻结)|达到.*上限|超过.*(上限|次数)|已达.*(上限|次数)|预约次数.*(用完|不足)/.test(message)) {
    return { kind: 'account', message };
  }
  if (/时段.*(过期|已开始|已结束)|预约时间已过|超过预约时间/.test(message)) return { kind: 'expired', message };
  if (/未开放|不开放|未到.*(预约|开放)|未到放号|预约时间未到|未开始预约|还未开放/.test(message)) {
    return { kind: 'wait', message, ...(/放号|未到.*预约时间|预约时间未到|未开始预约/.test(message) ? { scope: 'release' } : {}) };
  }
  if (/无空位|没有空位|满场|满员|已约满|已满|余量不足|名额已满|场地.*(已被预约|已被预订)|已被他人预约/.test(message)) {
    return { kind: 'retry', message };
  }
  return { kind: 'rejected', message: message || `学校拒绝预约（业务码 ${response.code}），请核对后再执行` };
}

export function executionStatus(result) {
  if (result.stopped) return result.error ? 'error' : 'stopped';
  if (result.ok) return 'success';
  if (result.successes?.length) return 'partial';
  if (result.error) return 'error';
  if (result.missed) return 'missed';
  if (result.limited) return 'limited';
  if (result.expired) return 'expired';
  return 'no_result';
}
