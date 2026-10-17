// Do not infer school meanings from undocumented numeric error codes.
// Unknown, explicit rejections stop with the original reason instead of looping.
export function classifyBookingResponse(response) {
  if (!response || Array.isArray(response) || typeof response.code !== 'string' || !response.code.trim()) {
    throw new Error('预约接口未返回明确业务结果，结果待确认，请核对学校“我的预约”');
  }
  if (response.code === 'HTTP_429') return { kind: 'retry', scope: 'rate', message: response.msg || '学校限制请求频率（HTTP 429）', retryAfterMs: 1000 };
  if (response.code === '0') return { kind: 'success' };
  if (response.code === 'LOCAL_DAILY_LIMIT') return { kind: 'limited' };
  if (response.code === 'LOCAL_ACCOUNT_STOPPED') return { kind: 'account', message: response.msg };
  if (response.code === 'SLOT_EXPIRED') return { kind: 'expired', message: response.msg };
  if (response.code === 'EXPIRED') return { kind: 'deadline', message: response.msg };
  const message = typeof response.msg === 'string' ? response.msg : '';
  if (/操作过于频繁|请求过于频繁|操作太频繁|请求太频繁/.test(message)) {
    return { kind: 'retry', scope: 'rate', message, retryAfterMs: 1000 };
  }
  if (/登录|身份认证|未支付|未付款|待支付|待付款|欠费|黑名单|账号.*(限制|冻结)|账户.*(限制|冻结)/.test(message)) {
    return { kind: 'account', message };
  }
  const capacity = /(?:场地|时段).*(?:人数|容量|名额).*(?:上限|不足)/.test(message);
  const personalQuota = /(?:您|你|本人|个人|每人|账号|账户|用户).*(?:可预约.*(?:时段|名额)|预约次数|预约数量).*(?:上限|不足|用完|不能超过|不得超过)/.test(message)
    || !capacity && /(?:您|你|本人|个人|每人|账号|账户|用户|每日|每天|当日|当天|预约次数).*(?:上限|次数.*(?:不足|用完)|不能超过|不得超过)/.test(message)
    || /预约次数.*(?:用完|不足)/.test(message);
  if (personalQuota) return { kind: 'account', message };
  if (/时段.*(过期|已开始|已结束)|预约时间已过|超过预约时间/.test(message)) return { kind: 'expired', message };
  if (/未开放|不开放|未到.*(预约|开放)|未到放号|预约时间未到|未开始预约|还未开放/.test(message)) {
    return { kind: 'wait', message, ...(/放号|未到.*预约时间|预约时间未到|未开始预约/.test(message) ? { scope: 'release' } : {}) };
  }
  if (/无空位|没有空位|满场|满员|已约满|已满|余量不足|名额已满|(?:场地|时段).*(?:人数|容量|名额).*(?:上限|不足)|(?:场地|时段).*(?:已被.*(?:预约|预订))|已被(?:他人|其他人).*预约/.test(message)) {
    return { kind: 'retry', message };
  }
  if (/(?:系统|服务).*(?:繁忙|暂时不可用|稍后再试)/.test(message)) return { kind: 'retry', scope: 'server', message, retryAfterMs: 1000 };
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
