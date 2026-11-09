/**
 * 最近错误环形缓冲：只给诊断页看「错误码 + 长度」，不含正文（§FR-21.5 隐私要求）。
 *
 * 进程内保存，不落盘：DSH 重启后清空，避免把用户原文或模型输出写进磁盘。
 */
const MAX = 20;
const ring = [];

export function recordError(code, message) {
  const text = String(message || '');
  ring.push({
    code: String(code || 'E_INTERNAL'),
    length: text.length,
    at: new Date().toISOString(),
  });
  while (ring.length > MAX) ring.shift();
  return ring[ring.length - 1];
}

export function recentErrors(limit = 5) {
  const count = Math.max(0, Math.min(MAX, Math.round(Number(limit) || 5)));
  return ring.slice(-count);
}

export function clearErrors() {
  ring.length = 0;
}
