// Utility function to wrap async route handlers and catch errors.
//
// Forwards every caught error to next(error) so the global errorHandler
// (src/middleware/error.middleware.ts) formats the response. That handler
// already reads AppError.statusCode — this wrapper used to short-circuit it
// by responding with a hardcoded 500 for every error, which meant every
// AppError thrown inside a controller (400 validation errors, 401s, 404s,
// 409 "already exists" conflicts, etc.) was reported to clients as a
// generic 500 Internal Server Error instead of its real status code.

import { NextFunction, Request, RequestHandler, Response } from "express";

export const catchAsync = (fn: RequestHandler) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await fn(req, res, next);
        } catch (error) {
            next(error);
        }
    }
}