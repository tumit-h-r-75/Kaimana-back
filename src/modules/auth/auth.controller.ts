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
    const result = await authService.registerWithPassword(req.body);
    setSessionCookies(res, result.accessToken, result.refreshToken);
    sendResponse(res, { success: true, statusCode: httpStatus.CREATED, message: "Account created", data: result });
});
const login = catchAsync(async (req, res) => {
    const result = await authService.loginWithPassword(req.body);
    setSessionCookies(res, result.accessToken, result.refreshToken);
    sendResponse(res, { success: true, statusCode: httpStatus.OK, message: "Logged in successfully", data: result });
});

const refreshToken = catchAsync(async (req, res) => {
    // Accepts the refresh token from the cookie (when that works) or from
    // the request body (the frontend's Bearer-token fallback, used because
    // the frontend and backend are on different domains and browsers
    // increasingly block cross-site cookies — see lib/api/client.ts on the
    // frontend for the matching side of this).
    const refreshToken = req.cookies?.refreshToken ?? (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const result = await authService.refreshToken(refreshToken);
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

export const authController = {
    googleClientConfig,
    googleAuth,
    register,
    login,
    refreshToken,
    logout,
    me,
};
