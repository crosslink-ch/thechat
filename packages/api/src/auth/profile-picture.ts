import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

export const MAX_PROFILE_PICTURE_BYTES = 128 * 1024;
export const MAX_PROFILE_PICTURE_DIMENSION = 1024;

const PROFILE_PICTURE_DATA_URL =
  /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const PROFILE_PICTURE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class ProfilePictureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilePictureValidationError";
  }
}

export async function normalizeProfilePicture(
  value: string | null,
): Promise<string | null> {
  if (value === null) return null;

  const match = PROFILE_PICTURE_DATA_URL.exec(value);
  if (!match) {
    throw new ProfilePictureValidationError(
      "Profile picture must be a PNG, JPEG, or WebP data URL",
    );
  }

  const [, declaredMediaType, encoded] = match;
  if (!declaredMediaType || !encoded || encoded.length % 4 !== 0) {
    throw new ProfilePictureValidationError("Profile picture encoding is invalid");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw new ProfilePictureValidationError("Profile picture encoding is invalid");
  }
  if (bytes.length > MAX_PROFILE_PICTURE_BYTES) {
    throw new ProfilePictureValidationError(
      "Profile picture must be 128 KB or smaller",
    );
  }

  let detectedMediaType: string | undefined;
  try {
    detectedMediaType = (await fileTypeFromBuffer(bytes))?.mime;
  } catch {
    // The common validation error below intentionally hides detector details.
  }
  if (
    detectedMediaType !== declaredMediaType ||
    !PROFILE_PICTURE_MEDIA_TYPES.has(detectedMediaType)
  ) {
    throw new ProfilePictureValidationError(
      "Profile picture must be a valid PNG, JPEG, or WebP image",
    );
  }

  try {
    const { info } = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels:
        MAX_PROFILE_PICTURE_DIMENSION * MAX_PROFILE_PICTURE_DIMENSION,
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_PROFILE_PICTURE_DIMENSION ||
      info.height > MAX_PROFILE_PICTURE_DIMENSION
    ) {
      throw new ProfilePictureValidationError(
        "Profile picture must be 1024 by 1024 pixels or smaller",
      );
    }
  } catch (error) {
    if (error instanceof ProfilePictureValidationError) throw error;
    throw new ProfilePictureValidationError(
      "Profile picture must be a complete, decodable PNG, JPEG, or WebP image",
    );
  }

  return `data:${detectedMediaType};base64,${encoded}`;
}
