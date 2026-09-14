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

// Claims shared by every access/refresh token the auth flows issue. `tv`
// snapshots the user's tokenVersion (see User.model.ts) at issuance, so
// incrementing that counter revokes every token signed before it.
const buildSessionPayload = (user: { _id: unknown; name: string; email: string; role: string; tokenVersion?: number }): JwtPayload => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    tv: user.tokenVersion ?? 0,
});

// Tokens issued before the `tv` claim existed count as version 0, so they
// keep working until the user's tokenVersion first moves past 0.
const tokenVersionMatches = (payload: JwtPayload, user: { tokenVersion?: number }) =>
    (payload.tv ?? 0) === (user.tokenVersion ?? 0);

export const jwtUtils = {
    createToken,
    verifyToken,
    buildSessionPayload,
    tokenVersionMatches,
}
