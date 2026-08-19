// Utility functions for standardizing API HTTP responses.

import { Response } from "express";

type TSendResponseData<T> = {
    success: boolean;
    statusCode: number;
    message: string;
    data: T;
}

export const sendResponse = <T>(res: Response, data: TSendResponseData<T>) => {
    res.status(data.statusCode).json({
        success: data.success,
        statusCode: data.statusCode,
        message: data.message,
        data: data.data,
    })
}