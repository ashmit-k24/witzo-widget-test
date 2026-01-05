import { NextFunction, Request, Response } from 'express';
import { body, ValidationChain, validationResult } from 'express-validator';
import logger from '../utils/logger';

// Validation rules
export const validationRules: Record<string, ValidationChain[]> = {
  requestCode: [
    body('email')
      .trim()
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail()
      .toLowerCase(),
  ],

  verifyCode: [
    body('email')
      .trim()
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail()
      .toLowerCase(),
    body('code')
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('Verification code must be 6 digits')
      .isNumeric()
      .withMessage('Verification code must contain only numbers'),
  ],
};

// Middleware to handle validation errors
export const validate = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => error.msg);
    
    logger.warn('Validation failed', { 
      errors: errorMessages,
      path: req.path,
      ip: req.ip,
    });

    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errorMessages,
    });
    return;
  }
  
  next();
};