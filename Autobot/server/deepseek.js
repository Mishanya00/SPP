export function completionRequest(model, system, prompt) {
  return {
    model,
    // These models think by default; reserve the output budget for the JSON/code.
    ...(/^(deepseek-flash|deepseek-v4-pro)$/.test(model) ? { thinking: { type: 'disabled' } } : {}),
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    max_tokens: 8000
  };
}

export function completionMetadata(answer) {
  const choice = answer?.choices?.[0];
  return {
    finishReason: choice?.finish_reason ?? null,
    contentLength: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
    reasoningLength: typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0,
    completionTokens: answer?.usage?.completion_tokens ?? null
  };
}

export function repairRequest(request, content, feedback) {
  return {
    ...request,
    messages: [
      ...request.messages,
      ...(typeof content === 'string' && content.trim() ? [{ role: 'assistant', content }] : []),
      { role: 'user', content: `Предыдущий ответ не прошёл проверку:\n${feedback}\nИсправь все ошибки, сохрани функциональность исходного описания. Верни полный исправленный JSON с name и code, а не патч. Соблюдай правила системного сообщения.` }
    ]
  };
}

export function parseCompletion(answer) {
  const choice = answer?.choices?.[0];
  if (!choice?.message) throw new Error('DeepSeek вернул ответ без choices[0].message. Повторите генерацию.');
  if (choice.finish_reason === 'length') {
    throw new Error('Ответ DeepSeek обрезан по лимиту токенов. Упростите описание бота и повторите генерацию.');
  }
  if (choice.finish_reason && choice.finish_reason !== 'stop') {
    throw new Error(`DeepSeek не завершил генерацию: finish_reason=${choice.finish_reason}. Повторите генерацию.`);
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('DeepSeek вернул пустой ответ вместо JSON. Повторите генерацию.');
  }
  // Accept a complete fenced JSON object, but never try to repair truncated code.
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  let result;
  try { result = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { throw new Error('Модель вернула некорректный JSON. Повторите генерацию.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.code !== 'string' || !result.code.trim() || result.code.length > 100000
      || typeof result.name !== 'string' || !result.name.trim() || result.name.length > 64) {
    throw new Error('Модель вернула некорректный код или название.');
  }
  return result;
}
