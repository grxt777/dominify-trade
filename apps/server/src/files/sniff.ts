/** Сигнатуры форматов, которые принимает платформа. Тип файла определяется по содержимому, а не по словам клиента. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  'audio/ogg': (b) => b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS',
};

export function matchesMime(buf: Buffer, mime: string): boolean {
  const check = SIGNATURES[mime];
  return !!check && check(buf);
}
