/**
 * Parser for PPMX format (custom float32 grayscale format)
 *
 * Format:
 * - Line 1: "P7" (magic header)
 * - Line 2: "width height" (dimensions)
 * - Line 3: flags (e.g., "00000000000")
 * - Binary data: width*height float32 values (little-endian)
 */

export interface PpmxData {
  width: number;
  height: number;
  values: Float32Array;
  min: number;
  max: number;
  orientation: PpmxOrientation;
  rgbBuffer: Buffer;
}

export interface PpmxRawData {
  width: number;
  height: number;
  values: Float32Array;
  min: number;
  max: number;
  orientation: PpmxOrientation;
}

export type PpmxColormap = 'grayscale' | 'jet';
export type PpmxOrientation = 'none' | 'rotate90cw';

export interface PpmxOrientationHint {
  width: number;
  height: number;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function mapColor(normalized: number, colormap: PpmxColormap): [number, number, number] {
  const t = clamp01(normalized);
  if (colormap === 'jet') {
    const fourT = 4 * t;
    const r = clamp01(Math.min(fourT - 1.5, -fourT + 4.5));
    const g = clamp01(Math.min(fourT - 0.5, -fourT + 3.5));
    const b = clamp01(Math.min(fourT + 0.5, -fourT + 2.5));
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  const gray = Math.round(t * 255);
  return [gray, gray, gray];
}

function orientationKind(width: number, height: number): 'portrait' | 'landscape' | 'square' {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

function resolveOrientation(
  width: number,
  height: number,
  hint?: PpmxOrientationHint
): PpmxOrientation {
  if (!hint || hint.width <= 0 || hint.height <= 0 || width === height) {
    return 'none';
  }

  const src = orientationKind(width, height);
  const target = orientationKind(hint.width, hint.height);

  if (src === 'square' || target === 'square' || src === target) {
    return 'none';
  }

  return 'rotate90cw';
}

function rotateValues90cw(values: Float32Array, width: number, height: number): Float32Array {
  const rotated = new Float32Array(values.length);
  const dstWidth = height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * width + x;
      const dstX = height - 1 - y;
      const dstY = x;
      const dstIdx = dstY * dstWidth + dstX;
      rotated[dstIdx] = values[srcIdx];
    }
  }

  return rotated;
}

export function parsePpmxRaw(
  buffer: Buffer,
  options?: { orientationHint?: PpmxOrientationHint }
): PpmxRawData {
  let pos = 0;
  const lines: string[] = [];

  for (let i = 0; i < 3; i++) {
    let lineEnd = pos;
    while (lineEnd < buffer.length && buffer[lineEnd] !== 10) {
      lineEnd++;
    }
    lines.push(buffer.slice(pos, lineEnd).toString('utf8').trim());
    pos = lineEnd + 1;
  }

  const [header, dims, flags] = lines;

  if (header !== 'P7') {
    throw new Error(`Unexpected PPMX header: "${header}", expected "P7"`);
  }

  const dimParts = dims.split(/\s+/);
  const width = parseInt(dimParts[0], 10);
  const height = parseInt(dimParts[1], 10);

  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid PPMX dimensions: "${dims}"`);
  }

  const KNOWN_FLAGS = new Set(['00000000000']);
  if (!KNOWN_FLAGS.has(flags)) {
    console.warn(`Unknown PPMX flags: "${flags}"`);
  }

  const dataBuffer = buffer.slice(pos);
  const expectedBytes = width * height * 4;

  if (dataBuffer.length < expectedBytes) {
    throw new Error(`PPMX data size mismatch: expected ${expectedBytes} bytes, got ${dataBuffer.length}`);
  }

  const values = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    values[i] = dataBuffer.readFloatLE(i * 4);
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // If all values are non-finite, keep a safe default range.
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }

  const orientation = resolveOrientation(width, height, options?.orientationHint);

  if (orientation === 'rotate90cw') {
    return {
      width: height,
      height: width,
      values: rotateValues90cw(values, width, height),
      min,
      max,
      orientation
    };
  }

  return { width, height, values, min, max, orientation: 'none' };
}

export function renderPpmxRgb(raw: PpmxRawData, colormap: PpmxColormap = 'grayscale'): Buffer {
  const rgbBuffer = Buffer.alloc(raw.width * raw.height * 3);
  const range = raw.max - raw.min || 1;

  for (let i = 0; i < raw.values.length; i++) {
    const v = raw.values[i];
    const normalized = Number.isFinite(v) ? (v - raw.min) / range : 0;
    const [r, g, b] = mapColor(normalized, colormap);
    const pi = i * 3;
    rgbBuffer[pi] = r;
    rgbBuffer[pi + 1] = g;
    rgbBuffer[pi + 2] = b;
  }

  return rgbBuffer;
}

/**
 * Parse a PPMX file and return grayscale image data as RGB buffer
 */
export function parsePpmx(
  buffer: Buffer,
  options?: { colormap?: PpmxColormap; orientationHint?: PpmxOrientationHint }
): PpmxData {
  const raw = parsePpmxRaw(buffer, { orientationHint: options?.orientationHint });
  const colormap = options?.colormap ?? 'grayscale';
  const rgbBuffer = renderPpmxRgb(raw, colormap);
  return {
    width: raw.width,
    height: raw.height,
    values: raw.values,
    min: raw.min,
    max: raw.max,
    orientation: raw.orientation,
    rgbBuffer
  };
}
