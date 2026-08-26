// Google OAuth integration for user authentication.

import { OAuth2Client } from "google-auth-library";
import { config } from "../../config/env.js";

export const googleClient = new OAuth2Client({
    client_id: config.googleClientId
});