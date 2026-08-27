export const MAX_PROFILE_PICTURE_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_PROFILE_PICTURE_OUTPUT_BYTES = 128 * 1024;
export const PROFILE_PICTURE_DIMENSION = 256;

const supportedMediaTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const jpegQualities = [0.86, 0.72, 0.58];

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The selected image could not be read"));
    image.src = url;
  });
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The selected image could not be processed"));
      },
      "image/jpeg",
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The selected image could not be processed"));
    };
    reader.onerror = () => reject(new Error("The selected image could not be read"));
    reader.readAsDataURL(blob);
  });
}

export async function prepareProfilePicture(file: File): Promise<string> {
  if (!supportedMediaTypes.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image");
  }
  if (file.size > MAX_PROFILE_PICTURE_SOURCE_BYTES) {
    throw new Error("Choose an image that is 10 MB or smaller");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("The selected image has invalid dimensions");
    }

    const scale = Math.min(
      1,
      PROFILE_PICTURE_DIMENSION /
        Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The selected image could not be processed");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    for (const quality of jpegQualities) {
      const blob = await encodeJpeg(canvas, quality);
      if (blob.size <= MAX_PROFILE_PICTURE_OUTPUT_BYTES) {
        return blobToDataUrl(blob);
      }
    }

    throw new Error("The selected image could not be compressed below 128 KB");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
