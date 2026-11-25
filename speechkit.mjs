// Server-only helpers. No public routes are enabled by this module.
export const MAX_AUDIO_BYTES = 20 * 16000 * 2;
export const MAX_TEXT_CHARS = 1500;

function apiKey() {
  const value = process.env.YANDEX_SPEECHKIT_API_KEY?.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new Error('SpeechKit: серверный ключ не настроен.');
  }
  return value;
}

async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SpeechKit: пустой ответ.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('SpeechKit: ответ превышает лимит.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function checkedFetch(url, options, limit) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: 'Api-Key ' + apiKey() },
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('SpeechKit HTTP ' + response.status + '. Проверь доступ, роли и баланс сервиса.');
      error.providerStatus = response.status;
      throw error;
    }
    return await boundedBody(response, limit);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('SpeechKit: время ожидания истекло. Запрос мог быть оплачен; автоматического повтора нет.');
    }
    if (error.message === 'fetch failed') {
      throw new Error('SpeechKit: не удалось подключиться к сервису.');
    }
    throw error;
  }
}

// Mono signed 16-bit little-endian PCM, 16 kHz, no WAV header, up to 20 seconds.
export async function recognizeSpeech(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 3200 ||
      pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 !== 0) {
    throw new Error('Нужна запись PCM16 mono 16000 Гц длительностью от 0,1 до 20 секунд.');
  }
  const query = new URLSearchParams({
    lang: 'ru-RU', topic: 'general', format: 'lpcm', sampleRateHertz: '16000'
  });
  const bytes = await checkedFetch(
    'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?' + query,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm },
    64000
  );
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('SpeechKit: неверный формат результата распознавания.'); }
  if (data.error_code || typeof data.result !== 'string') {
    throw new Error('SpeechKit: распознавание не выполнено.');
  }
  return data.result.trim().slice(0, 5000);
}

export async function synthesizeSpeech(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS) {
    throw new Error('Для озвучки нужно от 1 до 1500 символов.');
  }
  const audio = await checkedFetch(
    'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
    { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        text: text.trim(), lang: 'ru-RU', voice: 'filipp', format: 'mp3', speed: '1.0'
      })
    },
    2 * 1024 * 1024
  );
  if (!audio.length) throw new Error('SpeechKit: пустая аудиозапись.');
  return audio;
}
