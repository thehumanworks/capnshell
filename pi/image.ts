/**
 * The image types Pi's read tool attaches, detected from a file's first bytes.
 * Pi exports this only for local files (detectSupportedImageMimeTypeFromFile),
 * so this mirrors its utils/mime.ts (Pi 1.4.0) for bytes read over cns.
 */

/** Bytes Pi reads to detect an image. */
export const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageMimeType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : "image/jpeg";
  if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  if (ascii(buffer, 0, "GIF87a") || ascii(buffer, 0, "GIF89a")) return "image/gif";
  if (ascii(buffer, 0, "RIFF") && ascii(buffer, 8, "WEBP")) return "image/webp";
  if (ascii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return null;
}

function isPng(buffer: Uint8Array): boolean {
  return buffer.length >= 16 && uint32BE(buffer, PNG_SIGNATURE.length) === 13 && ascii(buffer, 12, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    if (ascii(buffer, offset + 4, "acTL")) return true;
    if (ascii(buffer, offset + 4, "IDAT")) return false;
    const next = offset + 8 + uint32BE(buffer, offset) + 4;
    if (next <= offset || next > buffer.length) return false;
    offset = next;
  }
  return false;
}

function isBmp(buffer: Uint8Array): boolean {
  if (buffer.length < 26) return false;
  const declaredSize = uint32LE(buffer, 2);
  const pixelOffset = uint32LE(buffer, 10);
  const headerSize = uint32LE(buffer, 14);
  if (declaredSize !== 0 && declaredSize < 26) return false;
  if (pixelOffset < 14 + headerSize) return false;
  if (declaredSize !== 0 && pixelOffset >= declaredSize) return false;
  let planes: number;
  let bits: number;
  if (headerSize === 12) {
    planes = uint16LE(buffer, 22);
    bits = uint16LE(buffer, 24);
  } else if (headerSize >= 40 && headerSize <= 124) {
    if (buffer.length < 30) return false;
    planes = uint16LE(buffer, 26);
    bits = uint16LE(buffer, 28);
  } else {
    return false;
  }
  return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}

const byte = (buffer: Uint8Array, offset: number) => buffer[offset] ?? 0;
const uint16LE = (buffer: Uint8Array, offset: number) => byte(buffer, offset) + (byte(buffer, offset + 1) << 8);
const uint32BE = (buffer: Uint8Array, offset: number) =>
  byte(buffer, offset) * 0x1000000 + (byte(buffer, offset + 1) << 16) + (byte(buffer, offset + 2) << 8) + byte(buffer, offset + 3);
const uint32LE = (buffer: Uint8Array, offset: number) =>
  byte(buffer, offset) + (byte(buffer, offset + 1) << 8) + (byte(buffer, offset + 2) << 16) + byte(buffer, offset + 3) * 0x1000000;

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
}

function ascii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
