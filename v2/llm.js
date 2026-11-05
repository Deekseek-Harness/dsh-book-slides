/** 2.0 模型调用：把 DSH 默认模型拼成一段文本。 */
export function resolveModel(ctx) {
  let selection = null;
  try {
    const model = ctx && ctx.get ? ctx.get('agentDefaultModel') : null;
    selection = model && typeof model.currentSelection === 'function' ? model.currentSelection() : null;
  } catch {
    selection = null;
  }
  const provider = String((selection && selection.provider) || '').trim();
  const model = String((selection && selection.model) || '').trim();
  if (!provider || !model) throw new Error('DSH 还没选好模型，先去设置里挑一个再回来');
  return { provider, model };
}

export async function callModel(ctx, system, user, { maxTokens = 12000, timeoutMs = 180000, signal = null } = {}) {
  const llm = ctx && ctx.get ? ctx.get('llm') : null;
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('这个 DSH 里没有可用的模型服务');
  const target = resolveModel(ctx);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal) : timeout;
  const prepared = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens }, combined);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let text = '';
  let stopReason = '';
  for await (const chunk of prepared.stream(Object.assign({}, prepared.config, { system, messages, signal: combined }))) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk && chunk.type === 'finish' && chunk.reason) {
      stopReason = String(chunk.reason.kind || '');
      if (chunk.reason.kind === 'error') {
        throw new Error('模型报错：' + ((chunk.reason.failure && chunk.reason.failure.message) || '未知原因'));
      }
    }
  }
  return { text, stopReason, model: target.model };
}

export function readJsonBlock(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象');
  return JSON.parse(raw.slice(start, end + 1));
}
