// Service layer for business logic related to authentication.

import { JwtPayload, SignOptions } from "jsonwebtoken";
import { config } from "../../config/env.js";
import { googleClient } from "../../integrations/google/googleAuth.js";
import { cloudinaryService } from "../../integrations/cloudinary/cloudinary.service.js";
import { UserModel, type IUser } from "../../models/User.model.js";
import { PasswordResetModel } from "../../models/PasswordReset.model.js";
import { EmailVerificationModel } from "../../models/EmailVerification.model.js";
import { SubmissionModel } from "../../models/Submission.model.js";
import { ProblemModel } from "../../models/Problem.model.js";
import { AppError } from "../../utils/errors.js";
import { jwtUtils } from "../../utils/jwt.js";
import { gemsForDifficulty } from "../../utils/gems.js";
import { mailService } from "../mail/mail.service.js";
import { mailTemplates } from "../mail/mail.templates.js";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);

// cloudinaryService.uploadAvatar() quietly resolves to null when Cloudinary
// isn't configured — fine when no photo was sent, but a photo that *was*
// sent would just vanish while the request still reported success.
const AVATAR_UPLOADS_NOT_CONFIGURED = "Avatar uploads are not configured on the server.";

// Every flow that signs a user in (Google, password login/register, refresh,
// password change) issues its tokens here, so they all carry the same
// claims — including `tv`, the tokenVersion that makes a session revocable.
const issueTokens = (user: { _id: unknown; name: string; email: string; role: "user" | "guest" | "admin"; tokenVersion?: number }) => {
    const payload = jwtUtils.buildSessionPayload(user);
    return { accessToken: jwtUtils.createToken(payload, config.jwtAccessSecret, config.jwtAccessExpiresIn as SignOptions), refreshToken: jwtUtils.createToken(payload, config.jwtRefreshSecret, config.jwtRefreshExpiresIn as SignOptions) };
};

// Auth responses hand the user record back to the client. The User schema's
// toJSON transform drops passwordHash, but only for a hydrated document —
// this also covers a lean/plain object, so the hash never goes out either way.
const toSafeUser = (user: unknown) => {
    const plain: Record<string, unknown> =
        typeof (user as { toJSON?: unknown }).toJSON === "function"
            ? (user as { toJSON: () => Record<string, unknown> }).toJSON()
            : { ...(user as Record<string, unknown>) };
    delete plain.passwordHash;
    delete plain.__v;
    return plain;
};

interface IGoogleLoginPayload {
    idToken?: unknown;
}

const googleAuthIntoDb = async (payload: IGoogleLoginPayload | undefined) => {
    const idToken = payload?.idToken;
    if (typeof idToken !== "string" || !idToken) {
        throw new AppError("A Google ID token is required.", 400);
    }

    let googleIdTokenPayload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: config.googleClientId,
        });
        googleIdTokenPayload = ticket.getPayload();
    } catch (err) {
        throw new AppError("Invalid Google token", 401);
    }

    if (!googleIdTokenPayload) {
        throw new AppError("Invalid Or Expired Google Id Token", 401);
    }

    const { sub: googleId, name, email, picture, email_verified: emailVerified } = googleIdTokenPayload;

    if (!email) {
        throw new AppError("Email is required", 400);
    }

    if (!googleId) {
        throw new AppError("Google ID is required", 400);
    }

    if (!name) {
        throw new AppError("Name is required", 400);
    }

    // Accounts are matched by email below, and a Google account can carry an
    // email address its owner never proved they control. Only an address
    // Google itself has verified is safe to match an existing account on.
    if (emailVerified !== true) {
        throw new AppError("Your Google account's email address is not verified.", 401);
    }

    // Match by Google id first, then email, so a user who registered with
    // email/password can safely link their Google account without a duplicate
    // email-key error. (Two lookups rather than one $or, so the Google-id
    // match really does win when the two would hit different accounts.)
    const normalizedEmail = email.toLowerCase();
    const existingUser = (await UserModel.findOne({ googleId })) ?? (await UserModel.findOne({ email: normalizedEmail }));
    const isNewUser = !existingUser

    // An account already linked to a *different* Google identity must never
    // be re-pointed at this one — that would hand it to whoever controls the
    // new Google login.
    if (existingUser?.googleId && existingUser.googleId !== googleId) {
        throw new AppError("This email is already linked to a different Google account.", 409);
    }

    let user;
    if (existingUser) {
        // Only fill in what's missing: link the Google id once, and never
        // overwrite a name or avatar the user has since set on Kaimana.
        const update: { googleId?: string; name?: string; profilePicUrl?: string } = {};
        if (!existingUser.googleId) update.googleId = googleId;
        if (!existingUser.name) update.name = name;
        if (!existingUser.profilePicUrl && picture) update.profilePicUrl = picture;
        user = Object.keys(update).length > 0
            ? await UserModel.findOneAndUpdate({ _id: existingUser._id }, { $set: update }, { new: true })
            : existingUser;
    } else {
        user = await UserModel.create({
            googleId,
            name,
            email,
            profilePicUrl: picture,
            role: "user",
            status: "active",
        });
    }

    if (!user) {
        throw new AppError("Failed to create or update user", 500);
    }
    if (user.status === "blocked") throw new AppError("This account is blocked.", 403);

    return {
        user: toSafeUser(user),
        ...issueTokens(user),
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

    const payload = verifiedRefreshToken.data as JwtPayload;

    const user = await UserModel.findById(payload._id);

    if (!user) {
        throw new AppError("User not found", 404);
    }

    // Refreshing is how a session outlives its short-lived access token, so
    // it must re-check what requireAuth does: a blocked account gets no new
    // tokens, and a refresh token signed under an older tokenVersion (revoked
    // by a password change) is dead.
    if (user.status === "blocked") {
        throw new AppError("This account is blocked.", 403);
    }
    if (!jwtUtils.tokenVersionMatches(payload, user)) {
        throw new AppError("Invalid refresh token", 401);
    }

    return issueTokens(user);
}

const hashPassword = async (password: string) => { const salt = randomBytes(16).toString("hex"); return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString("hex")}`; };
const passwordMatches = async (password: string, stored: string) => { const [salt, hash] = stored.split(":"); if (!salt || !hash) return false; const candidate = (await scrypt(password, salt, 64) as Buffer).toString("hex"); return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex")); };

// Body fields arrive straight from the client, so they're typed `unknown` and
// checked with typeof — a missing or non-string field is a 400, not a crash.
const registerWithPassword = async ({ name, email, password, avatarBuffer }: { name?: unknown; email?: unknown; password?: unknown; avatarBuffer?: Buffer }) => {
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string" || name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) throw new AppError("Enter a name, a valid email, and a password of at least 8 characters.", 400);
    const normalizedEmail = email.toLowerCase().trim();
    if (await UserModel.exists({ email: normalizedEmail })) throw new AppError("An account already exists for this email.", 409);
    if (avatarBuffer && !cloudinaryService.isConfigured) throw new AppError(AVATAR_UPLOADS_NOT_CONFIGURED, 503);
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
    void mailService.deliver(user.email, mailTemplates.welcome({ name: user.name }));
    // The confirmation goes out with the welcome; neither may hold up the
    // response that hands back the new session.
    void sendEmailVerification(user._id);
    return { user: toSafeUser(user), ...issueTokens(user), isNewUser: true };
};
const loginWithPassword = async ({ email, password }: { email?: unknown; password?: unknown }) => {
    if (typeof email !== "string" || typeof password !== "string") throw new AppError("Email and password are required.", 400);
    const user = await UserModel.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
    if (!user?.passwordHash || !(await passwordMatches(password, user.passwordHash))) throw new AppError("Invalid email or password.", 401);
    if ((user as unknown as { status?: string }).status === "blocked") throw new AppError("This account is blocked.", 403);
    return { user: toSafeUser(user), ...issueTokens(user), isNewUser: false };
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
        if (!cloudinaryService.isConfigured) throw new AppError(AVATAR_UPLOADS_NOT_CONFIGURED, 503);
        const profilePicUrl = await cloudinaryService.uploadAvatar(avatarBuffer);
        if (profilePicUrl) update.profilePicUrl = profilePicUrl;
    }

    const user = await UserModel.findByIdAndUpdate(userId, update, { new: true })
        .select("name email profilePicUrl role status createdAt updatedAt")
        .lean();
    if (!user) throw new AppError("User not found.", 404);
    return user;
};

const changePassword = async ({ userId, currentPassword, newPassword }: { userId: string; currentPassword?: unknown; newPassword?: unknown }) => {
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) throw new AppError("Current password and a new password are required.", 400);
    if (newPassword.length < 8) throw new AppError("New password must be at least 8 characters.", 400);

    const user = await UserModel.findById(userId).select("+passwordHash");
    if (!user) throw new AppError("User not found.", 404);
    // A Google-only account (no passwordHash) has nothing to check the
    // current password against — send a clear, specific reason instead of a
    // generic "invalid password" that would just confuse a Google user.
    if (!user.passwordHash) throw new AppError("This account signs in with Google and has no password to change.", 400);
    // 400, not 401: the frontend's API client treats every 401 as an expired
    // session (refresh, then sign out), so a mistyped current password would
    // log the user out instead of showing this message.
    if (!(await passwordMatches(currentPassword, user.passwordHash))) throw new AppError("Current password is incorrect.", 400);

    // Bumping tokenVersion revokes every token issued before this change, so
    // a stolen session dies with the old password. That includes the session
    // making this request, so it gets a fresh pair back (the controller sets
    // them as cookies and returns them for the frontend's Bearer fallback).
    const updated = await UserModel.findByIdAndUpdate(
        userId,
        { $set: { passwordHash: await hashPassword(newPassword) }, $inc: { tokenVersion: 1 } },
        { new: true },
    );
    if (!updated) throw new AppError("User not found.", 404);
    return issueTokens(updated);
};

// ------------------------------------------------------------ password reset

// Long enough to find the mail and act on it, short enough that a link left
// in an inbox is not a standing key to the account.
const PASSWORD_RESET_MINUTES = 30;
const MAX_RESET_REQUESTS_PER_HOUR = 3;

// The token goes in the link; only its hash is stored, the way a password is
// — a dump of the collection hands an attacker nothing they can put in a URL.
const hashResetToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Starts a reset. Resolves the same way whatever happens, because a reply
 * that differed would let anyone test which addresses have accounts here.
 */
const requestPasswordReset = async ({ email, requestedFrom }: { email?: unknown; requestedFrom?: string }) => {
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) throw new AppError("Enter the email address on the account.", 400);
    const user = await UserModel.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
    if (!user || (user as unknown as { status?: string }).status === "blocked") return;

    // A Google account has no password to reset. Saying so in the mail keeps
    // it out of the response, which anyone can read.
    if (!user.passwordHash) {
        await mailService.deliver(user.email, mailTemplates.passwordResetGoogleAccount({ name: user.name }), { urgent: true });
        return;
    }

    // The rate limit lives in the database rather than in memory: this runs
    // as serverless instances that share nothing between them.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if ((await PasswordResetModel.countDocuments({ userId: user._id, createdAt: { $gte: hourAgo } })) >= MAX_RESET_REQUESTS_PER_HOUR) return;

    const token = randomBytes(32).toString("base64url");
    await PasswordResetModel.create({
        userId: user._id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_MINUTES * 60 * 1000),
        requestedFrom,
    });
    const url = `${config.frontendUrls[0] ?? ""}/reset-password?token=${token}`;
    await mailService.deliver(user.email, mailTemplates.passwordReset({ name: user.name, url, minutes: PASSWORD_RESET_MINUTES }), { urgent: true });
};

/** Spends a reset link and sets the new password. */
const resetPassword = async ({ token, newPassword }: { token?: unknown; newPassword?: unknown }) => {
    if (typeof token !== "string" || !token) throw new AppError("This reset link is not valid.", 400);
    if (typeof newPassword !== "string" || newPassword.length < 8) throw new AppError("New password must be at least 8 characters.", 400);

    // Claimed before anything changes, and only if still unused: two clicks
    // on the same link race here, and exactly one of them wins.
    const claimed = await PasswordResetModel.findOneAndUpdate(
        { tokenHash: hashResetToken(token), usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
    );
    if (!claimed) throw new AppError("This reset link has expired or has already been used. Ask for a new one.", 400);

    const user = await UserModel.findById(claimed.userId);
    if (!user) throw new AppError("This reset link is not valid.", 400);

    // Bumping tokenVersion signs out every device, which is the point: a
    // reset is what someone does when the account may not be theirs alone.
    await UserModel.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(newPassword) }, $inc: { tokenVersion: 1 } });
    // Any other link still outstanding for this account dies with it.
    await PasswordResetModel.deleteMany({ userId: user._id, usedAt: { $exists: false } });
    // Not urgent, but it is how someone finds out their account was taken.
    await mailService.deliver(user.email, mailTemplates.passwordChanged({ name: user.name }));
};

/** Which optional emails this person wants. Transactional mail ignores it. */
const updateEmailPreferences = async ({ userId, contestReminders, weeklyDigest }: { userId: string; contestReminders?: unknown; weeklyDigest?: unknown }) => {
    const update: Record<string, boolean> = {};
    if (typeof contestReminders === "boolean") update["emailPrefs.contestReminders"] = contestReminders;
    if (typeof weeklyDigest === "boolean") update["emailPrefs.weeklyDigest"] = weeklyDigest;
    if (!Object.keys(update).length) throw new AppError("Nothing to change.", 400);
    const user = await UserModel.findByIdAndUpdate(userId, { $set: update }, { new: true });
    if (!user) throw new AppError("User not found.", 404);
    return { emailPrefs: { contestReminders: user.emailPrefs?.contestReminders !== false, weeklyDigest: user.emailPrefs?.weeklyDigest !== false } };
};

// ---------------------------------------------------------- email verify

const EMAIL_VERIFY_MINUTES = 60 * 24;
const MAX_VERIFY_SENDS_PER_HOUR = 3;

/**
 * Issues a confirmation link. Quiet on every path that is not worth telling
 * the caller about — already verified, no address, a mail provider having a
 * bad minute — because this is called from registration, where the account
 * has already been created and the response is about the account.
 */
const sendEmailVerification = async (userId: unknown) => {
    const user = await UserModel.findById(String(userId ?? ""));
    if (!user?.email || user.emailVerifiedAt) return;

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if ((await EmailVerificationModel.countDocuments({ userId: user._id, createdAt: { $gte: hourAgo } })) >= MAX_VERIFY_SENDS_PER_HOUR) return;

    const token = randomBytes(32).toString("base64url");
    await EmailVerificationModel.create({
        userId: user._id,
        email: user.email,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_MINUTES * 60 * 1000),
    });
    const url = `${config.frontendUrls[0] ?? ""}/verify-email?token=${token}`;
    await mailService.deliver(user.email, mailTemplates.verifyEmail({ name: user.name, url, minutes: EMAIL_VERIFY_MINUTES }), { urgent: true });
};

/** Spends a confirmation link. */
const verifyEmail = async ({ token }: { token?: unknown }) => {
    if (typeof token !== "string" || !token) throw new AppError("This confirmation link is not valid.", 400);

    const claimed = await EmailVerificationModel.findOneAndUpdate(
        { tokenHash: hashResetToken(token), usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
    );
    if (!claimed) throw new AppError("This confirmation link has expired or has already been used. Ask for a new one.", 400);

    // The address is checked as well as the owner: a link issued before
    // someone changed their email must not confirm the new one.
    const user = await UserModel.findOne({ _id: claimed.userId, email: claimed.email });
    if (!user) throw new AppError("This confirmation link is for a different address. Ask for a new one.", 400);

    if (!user.emailVerifiedAt) await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    return { email: user.email, verifiedAt: user.emailVerifiedAt ?? new Date() };
};

export const authService = { googleAuthIntoDb, registerWithPassword, loginWithPassword, refreshToken, getUserById, updateProfile, changePassword, requestPasswordReset, resetPassword, updateEmailPreferences, sendEmailVerification, verifyEmail };
