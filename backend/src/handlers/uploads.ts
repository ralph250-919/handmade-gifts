import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { env } from '../lib/config.js';
import { UserFacingError } from '../lib/errors.js';
import { httpHandler, json, parseJsonBody } from '../lib/http.js';
import { tracer } from '../lib/observability.js';

const s3 = tracer.captureAWSv3Client(new S3Client({}));
const types: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** Largest photo the admin page may upload. The size is signed into the upload URL, so S3 enforces it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const input = z.object({ contentType: z.string(), size: z.number().int().positive() });

/** POST /api/admin/uploads { contentType, size } -> { uploadUrl, imagePath } (admin only) */
export const handler = httpHandler(async (event) => {
  const parsed = input.safeParse(parseJsonBody(event));
  const ext = parsed.success ? types[parsed.data.contentType] : undefined;
  if (!parsed.success || !ext) throw new UserFacingError(400, 'Only JPEG, PNG or WebP images are allowed');
  if (parsed.data.size > MAX_UPLOAD_BYTES) throw new UserFacingError(400, 'Photos must be 10 MB or smaller', 'TOO_LARGE');

  // The images bucket is served by CloudFront under /images/*, so keys start with images/.
  const key = `images/products/${randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env('IMAGES_BUCKET'),
      Key: key,
      ContentType: parsed.data.contentType,
      // Signed, so the upload must be exactly this many bytes.
      ContentLength: parsed.data.size,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
    // Also sign the content type, so the browser can't upload e.g. HTML under an image URL.
    { expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) },
  );
  return json(200, { uploadUrl, imagePath: `/${key}` });
});
