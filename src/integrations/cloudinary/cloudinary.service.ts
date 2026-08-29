// Cloudinary integration for user avatar uploads (registration + profile).
//
// Same "Plan B" shape as ai.service.ts: when the three CLOUDINARY_* env vars
// aren't configured, uploadAvatar() resolves to null instead of throwing —
// registration and profile updates simply proceed without an avatar, so the
// app still works with zero Cloudinary setup.

import { v2 as cloudinary } from "cloudinary";
import { config } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

const isConfigured = Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);

if (isConfigured) {
    cloudinary.config({
        cloud_name: config.cloudinaryCloudName,
        api_key: config.cloudinaryApiKey,
        api_secret: config.cloudinaryApiSecret,
    });
}

export const MAX_AVATAR_BYTES = 4 * 1024 * 1024; // 4 MB
export const ALLOWED_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Uploads an in-memory image buffer (from multer's memoryStorage) to
 * Cloudinary and returns its secure URL, or null when Cloudinary isn't
 * configured. Throws AppError on an actual upload failure so the caller
 * can surface a real message instead of silently dropping the avatar.
 */
export const uploadAvatar = (buffer: Buffer): Promise<string | null> => {
    if (!isConfigured) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: "kaimana/avatars",
                resource_type: "image",
                // Keep avatars small and square-cropped so the UI never has to
                // deal with an oversized or oddly-shaped source image.
                transformation: [{ width: 320, height: 320, crop: "fill", gravity: "face" }],
            },
            (error, result) => {
                if (error || !result) {
                    reject(new AppError("Could not upload the image. Please try again.", 502));
                    return;
                }
                resolve(result.secure_url);
            },
        );
        stream.end(buffer);
    });
};

export const cloudinaryService = { uploadAvatar, isConfigured, MAX_AVATAR_BYTES, ALLOWED_AVATAR_MIME_TYPES };
