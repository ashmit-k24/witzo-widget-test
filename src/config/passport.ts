import passport from "passport";
import {
	Strategy as GoogleStrategy,
	Profile,
	VerifyCallback,
} from "passport-google-oauth20";
import { config } from "./env";
import { GoogleProfile } from "../services/googleAuthService";
import logger from "../utils/logger";

/**
 * Configure Passport with Google OAuth strategy
 */
export const configurePassport = (): void => {
	// Google OAuth Strategy
	passport.use(
		new GoogleStrategy(
			{
				clientID: config.GOOGLE_CLIENT_ID,
				clientSecret: config.GOOGLE_CLIENT_SECRET,
				callbackURL: config.GOOGLE_CALLBACK_URL,
				scope: ["profile", "email"],
			},
			async (
				_accessToken: string,
				_refreshToken: string,
				profile: Profile,
				done: VerifyCallback,
			) => {
				try {
					// Extract relevant profile information
					const googleProfile: GoogleProfile = {
						id: profile.id,
						email:
							profile.emails?.[0]?.value || "",
						verified_email:
							profile.emails?.[0]?.verified ??
							true,
						name: profile.displayName || "",
						given_name:
							profile.name?.givenName || "",
						family_name:
							profile.name?.familyName || "",
						picture:
							profile.photos?.[0]?.value || "",
					};

					if (!googleProfile.email) {
						logger.error(
							"Google profile missing email",
							{
								profileId: profile.id,
							},
						);
						return done(
							new Error(
								"Email not provided by Google",
							),
							undefined,
						);
					}

					logger.info(
						"Google OAuth profile retrieved",
						{
							email: googleProfile.email,
							verified:
								googleProfile.verified_email,
						},
					);

					// Pass the profile to the next middleware/controller
					return done(null, googleProfile as unknown as Express.User);
				} catch (error) {
					logger.error(
						"Error in Google OAuth strategy",
						{
							error: (error as Error).message,
						},
					);
					return done(error as Error, undefined);
				}
			},
		),
	);

	// Serialize user for session (we're not using sessions, but required by passport)
	passport.serializeUser((user, done) => {
		done(null, user);
	});

	// Deserialize user from session
	passport.deserializeUser(
		(user: Express.User, done) => {
			done(null, user);
		},
	);
};

export default passport;
