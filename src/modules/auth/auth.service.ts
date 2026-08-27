// Service layer for business logic related to authentication.

import { JwtPayload, SignOptions } from "jsonwebtoken";
import { config } from "../../config/env.js";
import { googleClient } from "../../integrations/google/googleAuth.js";
import { UserModel } from "../../models/User.model.js";
import { AppError } from "../../utils/errors.js";
import { jwtUtils } from "../../utils/jwt.js";
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

    const isUserExists = await UserModel.findOne({ googleId })
    const isNewUser = !isUserExists

    const user = isUserExists
        ? await UserModel.findOneAndUpdate(
            { googleId },
            { name, email, profilePicUrl: picture },
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

const registerWithPassword = async ({ name, email, password }: { name: string; email: string; password: string }) => {
    if (name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) throw new AppError("Enter a name, a valid email, and a password of at least 8 characters.", 400);
    const normalizedEmail = email.toLowerCase().trim();
    if (await UserModel.exists({ email: normalizedEmail })) throw new AppError("An account already exists for this email.", 409);
    const user = await UserModel.create({ name: name.trim(), email: normalizedEmail, passwordHash: await hashPassword(password), role: "user", status: "active" });
    return { user, ...issueTokens(user), isNewUser: true };
};
const loginWithPassword = async ({ email, password }: { email: string; password: string }) => {
    const user = await UserModel.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
    if (!user?.passwordHash || !(await passwordMatches(password, user.passwordHash))) throw new AppError("Invalid email or password.", 401);
    if ((user as unknown as { status?: string }).status === "blocked") throw new AppError("This account is blocked.", 403);
    return { user, ...issueTokens(user), isNewUser: false };
};

const getUserById = async (id: string) => {
    const user = await UserModel.findById(id).select("name email profilePicUrl role status createdAt updatedAt").lean();
    if (!user) throw new AppError("User not found.", 404);
    if ((user as unknown as { status?: string }).status === "blocked") throw new AppError("This account is blocked.", 403);
    return user;
};

export const authService = { googleAuthIntoDb, registerWithPassword, loginWithPassword, refreshToken, getUserById };
