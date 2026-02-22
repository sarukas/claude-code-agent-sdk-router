// Error handler middleware.

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiError } from '../types';

export function createApiError(
  message: string,
  statusCode: number = 500,
  code: string = 'internal_error',
  type: string = 'api_error',
): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.type = type;
  return error;
}

export async function errorHandler(
  error: ApiError,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  request.log.error(error);
  const statusCode = error.statusCode || 500;
  reply.code(statusCode).send({
    error: {
      message: error.message || 'Internal Server Error',
      type: error.type || 'api_error',
      code: error.code || 'internal_error',
    },
  });
}
