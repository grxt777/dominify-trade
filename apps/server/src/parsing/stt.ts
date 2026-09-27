/**
 * Распознавание речи через OpenAI-совместимый эндпоинт /audio/transcriptions.
 * Провайдера выбираем после сравнения на 50 настоящих голосовых из отраслевых групп.
 */
export async function transcribe(opts: {
  url: string;
  apiKey: string;
  model: string;
  audio: Buffer;
  fileName: string;
  mime: string;
  timeoutMs?: number;
}): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(opts.audio)], { type: opts.mime }), opts.fileName);
  form.append('model', opts.model);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}
