// Service layer for business logic related to authentication.

import { JwtPayload, SignOptions } from "jsonwebtoken";
import { config } from "../../config/env.js";
import { googleClient } from "../../integrations/google/googleAuth.js";
import { UserModel } from "../../models/User.model.js";
import { AppError } from "../../utils/errors.js";
import { jwtUtils } from "../../utils/jwt.js";

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

export const authService = {
    googleAuthIntoDb,
    refreshToken
}