import { Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Thrown for conditions that are the caller's fault and safe to describe back to
 * them ("email already registered", "property not found").
 *
 * Anything NOT an ApiError is treated as a bug: it gets logged in full and the
 * client receives a generic message. That distinction is the whole point — a raw
 * `error.message` from Prisma embeds the absolute server path, the failing source
 * line and schema internals, which is free reconnaissance for anyone poking the
 * API.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const badRequest = (message: string): ApiError => new ApiError(400, message);
export const unauthorized = (message = 'Authentication required'): ApiError => new ApiError(401, message);
export const forbidden = (message = 'Insufficient permissions'): ApiError => new ApiError(403, message);
export const notFound = (message: string): ApiError => new ApiError(404, message);
export const conflict = (message: string): ApiError => new ApiError(409, message);

/**
 * Maps a Prisma failure onto a safe, actionable client message.
 *
 * P2002 unique-constraint and P2003 foreign-key violations are the common case
 * here: the frontend used to send placeholder ids like `prop_1` that do not exist,
 * and the resulting FK error surfaced the whole query. These are caller errors, so
 * they get a real 4xx — just not the raw text.
 */
function describePrismaError(error: Prisma.PrismaClientKnownRequestError): { status: number; message: string } | null {
  switch (error.code) {
    case 'P2002': {
      const target = Array.isArray(error.meta?.target) ? (error.meta?.target as string[]).join(', ') : 'field';
      return { status: 409, message: `That ${target} is already in use.` };
    }
    case 'P2003':
      return { status: 400, message: 'Referenced record does not exist.' };
    case 'P2025':
      return { status: 404, message: 'Record not found.' };
    default:
      return null;
  }
}

/**
 * Single exit point for every route's catch block.
 *
 * @param context short route label, so the server log says which endpoint failed.
 */
export function handleError(res: Response, error: unknown, context: string): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const described = describePrismaError(error);
    if (described) {
      console.warn(`[${context}] ${described.status} ${error.code}: ${described.message}`);
      res.status(described.status).json({ success: false, error: described.message });
      return;
    }
    // An unmapped Prisma code is still an internal detail — log it, hide it.
    console.error(`[${context}] unhandled Prisma error ${error.code}`, error);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
    return;
  }

  console.error(`[${context}]`, error);
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
}
