// JWT token creation and verification utilities.

import jwt, { SignOptions, type JwtPayload } from "jsonwebtoken";

const createToken = (
    payload: JwtPayload,
    secret: string,
    expiresIn: SignOptions,
) => {
    const token = jwt.sign(payload, secret, { expiresIn } as SignOptions)
    return token;
}

const verifyToken = (token: string, secret: string) => {
    try {
        const verifiedToken = jwt.verify(token, secret);
        return {
            success: true,
            data: verifiedToken,
        }
    } catch (error) {
        console.log("Token verification failed: ", error);
        return {
            success: false,
            data: null
        }
    }
}

export const jwtUtils = {
    createToken,
    verifyToken
}