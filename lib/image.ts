// Client-side resize + JPEG re-encode before upload.
// JPEG rather than WebP because Safari's canvas can't encode WebP (it silently falls back to PNG).

export type Encoded = { blob: Blob; width: number; height: number };

async function encode(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Encoded> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode image"))), "image/jpeg", quality),
  );
  // release canvas memory early — iOS is strict about total canvas memory
  canvas.width = canvas.height = 0;
  return { blob, width, height };
}

export async function prepareImage(file: File) {
  // Modern browsers apply EXIF orientation by default, so phone photos come out upright
  const bitmap = await createImageBitmap(file);
  try {
    const full = await encode(bitmap, 2048, 0.82);
    const thumb = await encode(bitmap, 480, 0.72);
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}
