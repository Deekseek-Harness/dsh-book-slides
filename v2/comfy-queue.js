/**
 * ComfyUI 全局串行队列（FR-23.1 D10 / AC-152）。
 *
 * 配音与配图共用同一个 ComfyUI，同一时间只允许一个 /prompt 作业；
 * 排队任务可在开始前被取消（signal）或等待超时（maxWaitMs）。
 * 不调用 /interrupt：取消只停止轮询与落盘，ComfyUI 端任务可能继续跑完。
 */

export class ComfyQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComfyQueueError';
    this.code = code;
  }
}

let tail = Promise.resolve();

/**
 * 串行执行一个 ComfyUI 作业。
 * @param {Function} task 真正跑 ComfyUI 的函数
 * @param {{signal?: AbortSignal, maxWaitMs?: number}} [options]
 */
export function runComfyExclusive(task, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const signal = opts.signal;
  const maxWaitMs = Math.max(0, Number(opts.maxWaitMs) || 0);

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let started = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      if (started) return;
      cancelled = true;
      finish(reject, new ComfyQueueError('E_CANCELLED', '已取消'));
    };

    if (signal) {
      if (signal.aborted) {
        finish(reject, new ComfyQueueError('E_CANCELLED', '已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (maxWaitMs > 0) {
      timer = setTimeout(() => {
        if (started || settled) return;
        cancelled = true;
        finish(reject, new ComfyQueueError('E_TTS_BUSY', 'ComfyUI 正在处理其它作业，请稍后再试'));
      }, maxWaitMs);
    }

    const gate = tail.then(async () => {
      if (cancelled) {
        finish(reject, new ComfyQueueError('E_CANCELLED', '已取消'));
        return;
      }
      if (signal && signal.aborted) {
        finish(reject, new ComfyQueueError('E_CANCELLED', '已取消'));
        return;
      }
      started = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const value = await task();
        finish(resolve, value);
      } catch (err) {
        finish(reject, err);
      }
    });
    tail = gate.catch(() => {});
  });
}
