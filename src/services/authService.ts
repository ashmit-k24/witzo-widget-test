import { PoolClient } from 'pg';
import pool from '../config/database';
import { config } from '../config/env';
import {
  CleanupResult,
  LogoutResponse,
  RefreshTokenResponse,
  RequestCodeResponse,
  User,
  UserResponse,
  ValidationResponse,
  VerificationCode,
  VerifyCodeResponse,
} from '../types';
import logger from '../utils/logger';
import tokenUtil from '../utils/token';
import emailService from './emailService';

/**
 * Authentication Service
 * Handles email-based authentication with JWT tokens and refresh tokens
 */
class AuthService {
  /**
   * Generate a 6-digit verification code
   */
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Convert database user to API response format
   */
  private formatUserResponse(user: User): UserResponse {
    return {
      id: user.id,
      email: user.email,
      isVerified: user.is_verified,
    };
  }

  /**
   * Request verification code for authentication
   */
  async requestVerificationCode(email: string): Promise<RequestCodeResponse> {
    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      const normalizedEmail = email.toLowerCase().trim();

      // Check if user exists, if not create one
      const userResult = await client.query<User>(
        'SELECT id, is_verified FROM users WHERE email = $1',
        [normalizedEmail]
      );

      let userId: number;
      if (userResult.rows.length === 0) {
        // Create new user
        const insertResult = await client.query<{ id: number }>(
          'INSERT INTO users (email) VALUES ($1) RETURNING id',
          [normalizedEmail]
        );
        userId = insertResult.rows[0].id;
        logger.info('New user created', { email: normalizedEmail, userId });
      } else {
        userId = userResult.rows[0].id;
      }

      // Invalidate previous unused codes for this user
      await client.query(
        'UPDATE verification_codes SET is_used = TRUE WHERE user_id = $1 AND is_used = FALSE',
        [userId]
      );

      // Generate new verification code
      const code = this.generateVerificationCode();
      const expiresAt = new Date(Date.now() + config.VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);

      // Store verification code
      await client.query(
        `INSERT INTO verification_codes (user_id, code, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, code, expiresAt]
      );

      await client.query('COMMIT');

      // Send verification email asynchronously
      emailService.sendVerificationCode(normalizedEmail, code).catch((error: Error) => {
        logger.error('Failed to send verification email', {
          email: normalizedEmail,
          error: error.message,
        });
      });

      logger.info('Verification code generated', { email: normalizedEmail, userId });

      return {
        success: true,
        message: 'Verification code sent to your email',
        expiresIn: config.VERIFICATION_CODE_EXPIRY_MINUTES * 60, // in seconds
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const err = error as Error;
      logger.error('Error requesting verification code', {
        email,
        error: err.message,
        stack: err.stack,
      });
      throw new Error('Failed to generate verification code');
    } finally {
      client.release();
    }
  }

  /**
   * Verify code and create session with tokens
   */
  async verifyCode(
    email: string,
    code: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<VerifyCodeResponse & { accessToken?: string; refreshToken?: string }> {
    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      const normalizedEmail = email.toLowerCase().trim();

      // Get user
      const userResult = await client.query<User>(
        'SELECT id, email, is_verified FROM users WHERE email = $1',
        [normalizedEmail]
      );

      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: 'Invalid email or verification code',
        };
      }

      const user = userResult.rows[0];

      // Get the latest verification code
      const codeResult = await client.query<VerificationCode>(
        `SELECT id, code, attempts, expires_at, is_used
         FROM verification_codes
         WHERE user_id = $1 AND is_used = FALSE
         ORDER BY created_at DESC
         LIMIT 1`,
        [user.id]
      );

      if (codeResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: 'No valid verification code found. Please request a new one.',
        };
      }

      const verificationRecord = codeResult.rows[0];

      // Check if code has expired
      if (new Date() > new Date(verificationRecord.expires_at)) {
        await client.query('UPDATE verification_codes SET is_used = TRUE WHERE id = $1', [
          verificationRecord.id,
        ]);
        await client.query('COMMIT');
        return {
          success: false,
          message: 'Verification code has expired. Please request a new one.',
        };
      }

      // Check max attempts
      if (verificationRecord.attempts >= config.MAX_VERIFICATION_ATTEMPTS) {
        await client.query('UPDATE verification_codes SET is_used = TRUE WHERE id = $1', [
          verificationRecord.id,
        ]);
        await client.query('COMMIT');
        return {
          success: false,
          message: 'Maximum verification attempts exceeded. Please request a new code.',
        };
      }

      // Check if code matches
      if (verificationRecord.code !== code) {
        // Increment attempts
        await client.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [
          verificationRecord.id,
        ]);
        await client.query('COMMIT');

        const remainingAttempts =
          config.MAX_VERIFICATION_ATTEMPTS - (verificationRecord.attempts + 1);
        return {
          success: false,
          message: `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts !== 1 ? 's' : ''} remaining.`,
          remainingAttempts,
        };
      }

      // Code is valid - mark as used
      await client.query('UPDATE verification_codes SET is_used = TRUE WHERE id = $1', [
        verificationRecord.id,
      ]);

      // Update user as verified and last login
      await client.query(
        'UPDATE users SET is_verified = TRUE, last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );

      // Revoke old sessions for this user (optional security measure)
      await client.query(
        'UPDATE sessions SET is_revoked = TRUE WHERE user_id = $1 AND is_revoked = FALSE',
        [user.id]
      );

      // Create new session first to get the actual session ID
      const sessionResult = await client.query<{ id: number }>(
        `INSERT INTO sessions (
          user_id,
          access_token,
          refresh_token,
          access_token_expires_at,
          refresh_token_expires_at,
          ip_address,
          user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [
          user.id,
          'pending', // Temporary placeholder
          'pending', // Temporary placeholder
          new Date(Date.now() + config.ACCESS_TOKEN_EXPIRY_MINUTES * 60 * 1000),
          new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
          ipAddress || null,
          userAgent || null,
        ]
      );

      const sessionId = sessionResult.rows[0].id;

      // Generate access and refresh tokens with actual session ID
      const { token: accessToken, expiresAt: accessTokenExpiresAt } =
        tokenUtil.generateAccessToken({
          userId: user.id,
          email: user.email,
          sessionId,
        });

      const { token: refreshToken, expiresAt: refreshTokenExpiresAt } =
        tokenUtil.generateRefreshToken({
          userId: user.id,
          email: user.email,
          sessionId,
        });

      // Hash refresh token for storage
      const hashedRefreshToken = tokenUtil.hashToken(refreshToken);

      // Update session with actual tokens
      await client.query(
        `UPDATE sessions
         SET access_token = $1,
             refresh_token = $2,
             access_token_expires_at = $3,
             refresh_token_expires_at = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [accessToken, hashedRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, sessionId]
      );

      await client.query('COMMIT');

      logger.info('User verified and logged in', {
        email: normalizedEmail,
        userId: user.id,
        sessionId,
      });

      return {
        success: true,
        message: 'Login successful',
        accessToken,
        refreshToken,
        user: this.formatUserResponse(user),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const err = error as Error;
      logger.error('Error verifying code', {
        email,
        error: err.message,
        stack: err.stack,
      });
      throw new Error('Failed to verify code');
    } finally {
      client.release();
    }
  }

  /**
   * Validate access token
   */
  async validateAccessToken(accessToken: string): Promise<ValidationResponse> {
    try {
      // Verify token signature and expiry
      const verification = tokenUtil.verifyToken(accessToken, 'access');

      if (!verification.valid || !verification.payload) {
        return {
          valid: false,
          message: verification.error || 'Invalid access token',
        };
      }

      const { userId, sessionId } = verification.payload;

      // Check if session exists and is not revoked
      const sessionResult = await pool.query(
        `SELECT s.id, s.is_revoked, u.id as user_id, u.email, u.is_verified
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1 AND s.user_id = $2 AND s.access_token = $3 AND s.is_revoked = FALSE`,
        [sessionId, userId, accessToken]
      );

      if (sessionResult.rows.length === 0) {
        return {
          valid: false,
          message: 'Session not found or has been revoked',
        };
      }

      const session = sessionResult.rows[0];

      return {
        valid: true,
        user: {
          id: session.user_id,
          email: session.email,
          isVerified: session.is_verified,
        },
      };
    } catch (error) {
      const err = error as Error;
      logger.error('Error validating access token', {
        error: err.message,
        stack: err.stack,
      });
      return {
        valid: false,
        message: 'Token validation failed',
      };
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshTokenResponse & { accessToken?: string; newRefreshToken?: string }> {
    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify refresh token
      const verification = tokenUtil.verifyToken(refreshToken, 'refresh');

      if (!verification.valid || !verification.payload) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: verification.error || 'Invalid refresh token',
        };
      }

      const { userId, sessionId } = verification.payload;
      const hashedRefreshToken = tokenUtil.hashToken(refreshToken);

      // Verify session and refresh token
      const sessionResult = await client.query<{
        id: number;
        user_id: number;
        email: string;
        is_verified: boolean;
        refresh_token_expires_at: Date;
      }>(
        `SELECT s.id, s.user_id, u.email, u.is_verified, s.refresh_token_expires_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1
           AND s.user_id = $2
           AND s.refresh_token = $3
           AND s.is_revoked = FALSE
           AND s.refresh_token_expires_at > CURRENT_TIMESTAMP`,
        [sessionId, userId, hashedRefreshToken]
      );

      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: 'Invalid or expired refresh token',
        };
      }

      const session = sessionResult.rows[0];

      // Generate new access token
      const { token: newAccessToken, expiresAt: accessTokenExpiresAt } =
        tokenUtil.generateAccessToken({
          userId: session.user_id,
          email: session.email,
          sessionId: session.id,
        });

      // Generate new refresh token (token rotation)
      const { token: newRefreshToken, expiresAt: refreshTokenExpiresAt } =
        tokenUtil.generateRefreshToken({
          userId: session.user_id,
          email: session.email,
          sessionId: session.id,
        });

      const hashedNewRefreshToken = tokenUtil.hashToken(newRefreshToken);

      // Update session with new tokens
      await client.query(
        `UPDATE sessions
         SET access_token = $1,
             refresh_token = $2,
             access_token_expires_at = $3,
             refresh_token_expires_at = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [newAccessToken, hashedNewRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, session.id]
      );

      await client.query('COMMIT');

      logger.info('Access token refreshed', {
        userId: session.user_id,
        sessionId: session.id,
      });

      return {
        success: true,
        message: 'Token refreshed successfully',
        accessToken: newAccessToken,
        newRefreshToken,
        user: {
          id: session.user_id,
          email: session.email,
          isVerified: session.is_verified,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const err = error as Error;
      logger.error('Error refreshing token', {
        error: err.message,
        stack: err.stack,
      });
      throw new Error('Failed to refresh token');
    } finally {
      client.release();
    }
  }

  /**
   * Logout - revoke session
   */
  async logout(accessToken: string): Promise<LogoutResponse> {
    try {
      // Verify token to get session ID
      const verification = tokenUtil.verifyToken(accessToken, 'access');

      if (!verification.valid || !verification.payload) {
        return {
          success: false,
          message: 'Invalid access token',
        };
      }

      const { sessionId } = verification.payload;

      // Revoke session
      const result = await pool.query(
        'UPDATE sessions SET is_revoked = TRUE WHERE id = $1 AND is_revoked = FALSE',
        [sessionId]
      );

      if (result.rowCount === null || result.rowCount === 0) {
        return {
          success: false,
          message: 'Session not found or already logged out',
        };
      }

      logger.info('User logged out', { sessionId });

      return {
        success: true,
        message: 'Logged out successfully',
      };
    } catch (error) {
      const err = error as Error;
      logger.error('Error logging out', {
        error: err.message,
        stack: err.stack,
      });
      throw new Error('Failed to logout');
    }
  }

  /**
   * Clean up expired sessions and verification codes
   */
  async cleanupExpired(): Promise<CleanupResult> {
    try {
      // Revoke expired sessions
      const sessionsResult = await pool.query(
        `UPDATE sessions
         SET is_revoked = TRUE
         WHERE (refresh_token_expires_at < CURRENT_TIMESTAMP OR refresh_token_expires_at IS NULL)
           AND is_revoked = FALSE`
      );

      // Delete old revoked sessions (older than 30 days)
      await pool.query(
        `DELETE FROM sessions
         WHERE is_revoked = TRUE
           AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'`
      );

      // Delete expired or used verification codes
      const codesResult = await pool.query(
        'DELETE FROM verification_codes WHERE expires_at < CURRENT_TIMESTAMP OR is_used = TRUE'
      );

      logger.info('Cleanup completed', {
        sessionsRevoked: sessionsResult.rowCount,
        codesDeleted: codesResult.rowCount,
      });

      return {
        sessionsDeleted: sessionsResult.rowCount || 0,
        codesDeleted: codesResult.rowCount || 0,
      };
    } catch (error) {
      const err = error as Error;
      logger.error('Error during cleanup', {
        error: err.message,
        stack: err.stack,
      });
      throw new Error('Failed to cleanup expired records');
    }
  }
}

export default new AuthService();
