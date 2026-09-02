// Service layer for business logic related to authentication.

import { JwtPayload, SignOptions } from "jsonwebtoken";
import { config } from "../../config/env.js";
import { googleClient } from "../../integrations/google/googleAuth.js";
import { cloudinaryService } from "../../integrations/cloudinary/cloudinary.service.js";
import { UserModel, type IUser } from "../../models/User.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { jwtUtils } from "../../utils/jwt.js";
import { gemsForDifficulty } from "../../utils/gems.js";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);

interface IGoogleLoginPayload {
    idToken: string;
}

const googleAuthIntoDb = async (payload: IGoogleLoginPayload) => {
    let googleIdTokenPayload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: payload.idToken,
            audience: config.googleClientId,
        });
        googleIdTokenPayload = ticket.getPayload();
    } catch (err) {
        throw new AppError("Invalid Google token", 401);
    }

    if (!googleIdTokenPayload) {
        throw new Error("Invalid Or Expired Google Id Token");
    }

    const { sub: googleId, name, email, picture } = googleIdTokenPayload;

    if (!email) {
        throw new AppError("Email is required", 400);
    }

    if (!googleId) {
        throw new AppError("Google ID is required", 400);
    }

    if (!name) {
        throw new AppError("Name is required", 400);
    }

    // Match by Google id first, then email, so a user who registered with
    // email/password can safely link their Google account without a duplicate
    // email-key error.
    const isUserExists = await UserModel.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    const isNewUser = !isUserExists

    const user = isUserExists
        ? await UserModel.findOneAndUpdate(
            { _id: isUserExists._id },
            { googleId, name, email: email.toLowerCase(), profilePicUrl: picture },
            { new: true }
        )
        : await UserModel.create({
            googleId,
            name,
            email,
            profilePicUrl: picture,
            role: "user",
            status: "active",
        });

    if (!user) {
        throw new AppError("Failed to create or update user", 500);
    }
    if (user.status === "blocked") throw new AppError("This account is blocked.", 403);

    const jwtPayload = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
    }

    const accessToken = jwtUtils.createToken(
        jwtPayload,
        config.jwtAccessSecret,
        config.jwtAccessExpiresIn as SignOptions
    )

    const refreshToken = jwtUtils.createToken(
        jwtPayload,
        config.jwtRefreshSecret,
        config.jwtRefreshExpiresIn as SignOptions
    )

    return {
        user,
        accessToken,
        refreshToken,
        isNewUser
    }
}

const refreshToken = async (refreshToken: string) => {
    const verifiedRefreshToken = jwtUtils.verifyToken(
        refreshToken,
        config.jwtRefreshSecret,
    );

    if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
        throw new AppError("Invalid refresh token", 401);
    }

    const { _id, name, email, role } = verifiedRefreshToken.data as JwtPayload;

    const user = await UserModel.findById(_id);

    if (!user) {
        throw new AppError("User not found", 404);
    }

    const jwtPayload = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
    }

    const accessToken = jwtUtils.createToken(
        jwtPayload,
        config.jwtAccessSecret,
        config.jwtAccessExpiresIn as SignOptions
    )

    const newRefreshToken = jwtUtils.createToken(
        jwtPayload,
        config.jwtRefreshSecret,
        config.jwtRefreshExpiresIn as SignOptions
    )

    return {
        accessToken,
        refreshToken: newRefreshToken
    }
}

const issueTokens = (user: { _id: unknown; name: string; email: string; role: "user" | "admin" }) => {
    const payload = { _id: user._id, name: user.name, email: user.email, role: user.role };
    return { accessToken: jwtUtils.createToken(payload, config.jwtAccessSecret, config.jwtAccessExpiresIn as SignOptions), refreshToken: jwtUtils.createToken(payload, config.jwtRefreshSecret, config.jwtRefreshExpiresIn as SignOptions) };
};
const hashPassword = async (password: string) => { const salt = randomBytes(16).toString("hex"); return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString("hex")}`; };
const passwordMatches = async (password: string, stored: string) => { const [salt, hash] = stored.split(":"); if (!salt || !hash) return false; const candidate = (await scrypt(password, salt, 64) as Buffer).toString("hex"); return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex")); };

const registerWithPassword = async ({ name, email, password, avatarBuffer }: { name: string; email: string; password: string; avatarBuffer?: Buffer }) => {
    if (name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) throw new AppError("Enter a name, a valid email, and a password of at least 8 characters.", 400);
    const normalizedEmail = email.toLowerCase().trim();
    if (await UserModel.exists({ email: normalizedEmail })) throw new AppError("An account already exists for this email.", 409);
    // Uploads first, before creating the account, so a bad image (rejected
    // or failed upload) never leaves behind a user with no way to retry the
    // photo — the whole request just fails and the client tries again.
    const profilePicUrl = avatarBuffer ? await cloudinaryService.uploadAvatar(avatarBuffer) : undefined;
    const user = await UserModel.create({
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: await hashPassword(password),
        role: "user",
        status: "active",
        ...(profilePicUrl ? { profilePicUrl } : {}),
    });
    return { user, ...issueTokens(user), isNewUser: true };
};
const loginWithPassword = async ({ email, password }: { email: string; password: string }) => {
    const user = await UserModel.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
    if (!user?.passwordHash || !(await passwordMatches(password, user.passwordHash))) throw new AppError("Invalid email or password.", 401);
    if ((user as unknown as { status?: string }).status === "blocked") throw new AppError("This account is blocked.", 403);
    return { user, ...issueTokens(user), isNewUser: false };
};

// Gems shipped after some users had already solved problems the normal
// way (submission.controller.ts only awards gems on a NEW first-ever
// ACCEPTED, so an already-solved problem never re-triggers it). Rather
// than a one-off migration script against production data, this backfills
// lazily and idempotently: `.lean()` queries never apply schema defaults
// for a field that was never actually written to the document, so an
// account from before this feature has no `gems` key at all (not even
// 0) — that missing key IS the "never backfilled" signal. Once computed
// and persisted here, the key exists (even at 0) and this never runs
// again for that user; a genuinely new user with nothing solved yet also
// converges to a real, present 0 on their very first /auth/me call.
const backfillGemsForUser = async (userId: string): Promise<number> => {
    const solvedProblemIds = await SubmissionModel.distinct("problemId", { userId, verdict: "ACCEPTED" });
    let total = 0;
    if (solvedProblemIds.length > 0) {
        const problems = await ProblemModel.find({ _id: { $in: solvedProblemIds } })
            .select("difficulty")
            .lean<{ difficulty: string }[]>();
        total = problems.reduce((sum, problem) => sum + gemsForDifficulty(problem.difficulty), 0);
    }
    await UserModel.findByIdAndUpdate(userId, { $set: { gems: total } });
    return total;
};

const getUserById = async (id: string) => {
    // passwordHash is select:false on the schema (never returned by default)
    // — pulled in here only to derive hasPassword, then stripped before the
    // response goes out, so the frontend can tell a Google-only account
    // apart from one with a password (and hide "Change password" for the
    // former) without ever seeing the hash itself.
    const user = await UserModel.findById(id)
        .select("name email profilePicUrl role status gems createdAt updatedAt passwordHash")
        .lean<
            (Pick<IUser, "name" | "email" | "profilePicUrl" | "role" | "status" | "gems" | "createdAt" | "updatedAt" | "passwordHash"> & {
                _id: unknown;
            })
            | null
        >();
    if (!user) throw new AppError("User not found.", 404);
    if (user.status === "blocked") throw new AppError("This account is blocked.", 403);
    const { passwordHash, ...rest } = user;
    const gems = typeof rest.gems === "number" ? rest.gems : await backfillGemsForUser(id);
    return { ...rest, gems, hasPassword: Boolean(passwordHash) };
};

// Profile editing (name + avatar) was never actually wired up — the
// Cloudinary avatar pipeline above already anticipated it ("registration +
// profile" in its own comment) but no route ever called it for anything but
// registration, and there was no way at all to change your name afterward.
const updateProfile = async ({ userId, name, avatarBuffer }: { userId: string; name?: string; avatarBuffer?: Buffer }) => {
    const trimmedName = name?.trim();
    if (trimmedName !== undefined && trimmedName.length < 2) throw new AppError("Name must be at least 2 characters.", 400);
    if (trimmedName === undefined && !avatarBuffer) throw new AppError("Nothing to update — provide a name and/or a photo.", 400);

    const update: { name?: string; profilePicUrl?: string } = {};
    if (trimmedName) update.name = trimmedName;
    // Same ordering rationale as registerWithPassword: upload before saving,
    // so a rejected/failed image never leaves a half-applied update.
    if (avatarBuffer) {
        const profilePicUrl = await cloudinaryService.uploadAvatar(avatarBuffer);
        if (profilePicUrl) update.profilePicUrl = profilePicUrl;
    }

    const user = await UserModel.findByIdAndUpdate(userId, update, { new: true })
        .select("name email profilePicUrl role status createdAt updatedAt")
        .lean();
    if (!user) throw new AppError("User not found.", 404);
    return user;
};

const changePassword = async ({ userId, currentPassword, newPassword }: { userId: string; currentPassword?: string; newPassword?: string }) => {
    if (!currentPassword || !newPassword) throw new AppError("Current password and a new password are required.", 400);
    if (newPassword.length < 8) throw new AppError("New password must be at least 8 characters.", 400);

    const user = await UserModel.findById(userId).select("+passwordHash");
    if (!user) throw new AppError("User not found.", 404);
    // A Google-only account (no passwordHash) has nothing to check the
    // current password against — send a clear, specific reason instead of a
    // generic "invalid password" that would just confuse a Google user.
    if (!user.passwordHash) throw new AppError("This account signs in with Google and has no password to change.", 400);
    if (!(await passwordMatches(currentPassword, user.passwordHash))) throw new AppError("Current password is incorrect.", 401);

    user.passwordHash = await hashPassword(newPassword);
    await user.save();
    return { updated: true };
};

export const authService = { googleAuthIntoDb, registerWithPassword, loginWithPassword, refreshToken, getUserById, updateProfile, changePassword };
