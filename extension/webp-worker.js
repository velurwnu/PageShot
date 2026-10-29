/*
 * PageShot — кодирование WebP в отдельном потоке (module worker).
 *
 * Safari не умеет canvas.toBlob('image/webp') — молча отдаёт PNG. Поэтому
 * кодируем сами: libwebp, собранный в WebAssembly (vendor/webp, из @jsquash/webp).
 * Кодирование большого снимка занимает секунды, в воркере страница не подвисает,
 * а после сохранения воркер закрывают — и память WASM (до 2 ГБ) освобождается.
 *
 * Вход:  { id, width, height, buffer: ArrayBuffer RGBA, quality: 0–100 }
 * Выход: { id, buffer: ArrayBuffer с файлом WebP } или { id, error }
 */

// Поля struct WebPConfig из libwebp/encode.h; embind требует все.
const OPTIONS = {
  quality: 85,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

let modP = null;

// Сначала сборка с SIMD (быстрее), если движок её не потянет — обычная
async function load() {
  try {
    const m = await import('./vendor/webp/webp_enc_simd.js');
    return await m.default({ noInitialRun: true });
  } catch {
    const m = await import('./vendor/webp/webp_enc.js');
    return await m.default({ noInitialRun: true });
  }
}

self.onmessage = async ({ data }) => {
  const { id, width, height, buffer, quality } = data;
  try {
    modP = modP || load();
    const mod = await modP;
    const q = Number.isFinite(quality) ? Math.max(0, Math.min(100, quality)) : OPTIONS.quality;
    const out = mod.encode(new Uint8ClampedArray(buffer), width, height, { ...OPTIONS, quality: q });
    if (!out) throw new Error('libwebp не смог закодировать изображение');
    self.postMessage({ id, buffer: out.buffer }, [out.buffer]);
  } catch (e) {
    modP = null;
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
