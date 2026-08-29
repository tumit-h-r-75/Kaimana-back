// Controller for user authentication, Google OAuth flow, and JWT management.

import { catchAsync } from "../../utils/catchAsync.js"
import { sendResponse } from "../../utils/response.js";
import { authService } from "./auth.service.js";
import httpStatus from "http-status";
import { config } from "../../config/env.js";
import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/auth.middleware.js";

const isProduction = config.nodeEnv === "production";

const googleClientConfig = (_req: Request, res: Response) => {
    if (!config.googleClientId) {
        return res.status(httpStatus.SERVICE_UNAVAILABLE).json({
            success: false,
            message: "Google sign-in is not configured.",
        });
    }

    return res.status(httpStatus.OK).json({
        success: true,
        data: { clientId: config.googleClientId },
    });
};

const googleAuth = catchAsync(async (req, res) => {
    const payload = req.body;
    const result = await authService.googleAuthIntoDb(payload);
    const { accessToken, refreshToken, isNewUser } = result;

    res.cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 1000 * 60 * 60 * 24, // 24 hour or 1 day
    });

    res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });

    sendResponse(res, {
        success: true,
        statusCode: httpStatus.OK,
        message: isNewUser ? "Account created" : "Logged in successfully",
        data: result,
    })

})

const setSessionCookies = (res: Response, accessToken: string, refreshToken: string) => {
    const base = { httpOnly: true, secure: isProduction, sameSite: isProduction ? "none" as const : "lax" as const };
    res.cookie("accessToken", accessToken, { ...base, maxAge: 1000 * 60 * 60 * 24 });
    res.cookie("refreshToken", refreshToken, { ...base, maxAge: 1000 * 60 * 60 * 24 * 7 });
};
const register = catchAsync(async (req, res) => {
    // req.file is set by avatarUpload (multer) only when the request was
    // multipart/form-data with an "avatar" field — a plain JSON signup
    // (no photo) leaves it undefined and registration proceeds without one.
    const avatarBuffer = (req as Request & { file?: { buffer: Buffer } }).file?.buffer;
    const result = await authService.registerWithPassword({ ...req.body, avatarBuffer });
    setSessionCookies(res, result.accessToken, result.refreshToken);
    sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Account created", data: result });
});
const login = catchAsync(async (req, res) => {
    const result = await authService.loginWithPassword(req.body);
    setSessionCookies(res, result.accessToken, result.refreshToken);
    sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Logged in successfully", data: result });
});

const refreshToken = catchAsync(async (req, res) => {
    // The frontend always sends the refresh token in the body (its
    // Bearer-token fallback — see lib/api/client.ts); the cookie is a
    // secondary path that works when the browser accepts it. Try the body
    // first: authService.refreshToken() throws on an invalid/expired token,
    // so if the body token is present but somehow fails, fall back to
    // whatever the cookie holds rather than giving up immediately — the two
    // can otherwise fall out of sync (e.g. a stale cookie from an earlier
    // session) and we don't want a bad cookie to block a good body token,
    // or vice versa.
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const cookieToken = req.cookies?.refreshToken;
    let result;
    try {
        result = await authService.refreshToken(bodyToken ?? cookieToken);
    } catch (error) {
        if (!bodyToken || !cookieToken || bodyToken === cookieToken) throw error;
        result = await authService.refreshToken(cookieToken);
    }
    const { accessToken, refreshToken: newRefreshToken } = result;

    res.cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 1000 * 60 * 60 * 24, // 24 hour or 1 day
    });

    res.cookie("refreshToken", newRefreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });

    sendResponse(res, {
        success: true,
        statusCode: httpStatus.OK,
        message: "Token refreshed successfully",
        data: result,
    });
});

const logout = catchAsync(async (req, res) => {
    res.clearCookie("accessToken", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
    });

    res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
    });

    sendResponse(res, {
        success: true,
        statusCode: httpStatus.OK,
        message: "Logged out successfully",
        data: null,
    });
});

const me = catchAsync(async (req: AuthenticatedRequest, res) => {
    const user = await authService.getUserById(String(req.user?._id));
    sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Profile loaded", data: user });
});

const updateProfile = catchAsync(async (req: AuthenticatedRequest, res) => {
    // Same optional-file pattern as register: req.file only exists when the
    // request was multipart/form-data with an "avatar" field.
    const avatarBuffer = (req as AuthenticatedRequest & { file?: { buffer: Buffer } }).file?.buffer;
    const user = await authService.updateProfile({ userId: String(req.user?._id), name: req.body.name, avatarBuffer });
    sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Profile updated", data: user });
});

const changePassword = catchAsync(async (req: AuthenticatedRequest, res) => {
    await authService.changePassword({ userId: String(req.user?._id), currentPassword: req.body.currentPassword, newPassword: req.body.newPassword });
    sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Password updated", data: null });
});

export const authController = {
    googleClientConfig,
    googleAuth,
    register,
    login,
    refreshToken,
    logout,
    me,
    updateProfile,
    changePassword,
};
