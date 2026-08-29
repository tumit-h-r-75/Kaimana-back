// Multer middleware for the optional avatar file on registration/profile
// forms. Uses memory storage (no disk writes) since the buffer goes straight
// to Cloudinary — see integrations/cloudinary/cloudinary.service.ts.

import multer from "multer";
import { ALLOWED_AVATAR_MIME_TYPES, MAX_AVATAR_BYTES } from "../integrations/cloudinary/cloudinary.service.js";

const storage = multer.memoryStorage();

export const avatarUpload = multer({
    storage,
    limits: { fileSize: MAX_AVATAR_BYTES },
    fileFilter: (_req, file, callback) => {
        if (!ALLOWED_AVATAR_MIME_TYPES.includes(file.mimetype)) {
            callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "avatar"));
            return;
        }
        callback(null, true);
    },
}).single("avatar");
