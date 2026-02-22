import { FastifyReply } from 'fastify'
import { config } from '../config.js'

interface PgError {
  code?: string;
  detail?: string;
  message?: string;
  constraint?: string;
}

const PG_ERROR_MAP: Record<string, { status: number; error: string; message: string }> = {
  23505: { status: 409, error: 'Conflict', message: 'A record with this key already exists' },
  23503: { status: 400, error: 'Foreign key violation', message: 'Referenced record does not exist' },
  23502: { status: 400, error: 'Not null violation', message: 'Required field is missing' },
  '22P02': { status: 400, error: 'Invalid input', message: 'Invalid data type provided' },
}

export function handleDbError (error: unknown, reply: FastifyReply) {
  const err = error as PgError

  const mapped = err.code ? PG_ERROR_MAP[err.code] : undefined
  if (mapped) {
    reply.request.log.error(err, 'Database error')
    return reply.status(mapped.status).send({
      error: mapped.error,
      message: mapped.message,
      ...(config.exposeDbErrors
        ? {
            detail: err.detail ?? err.message,
            ...(err.constraint ? { constraint: err.constraint } : {}),
          }
        : {}),
    })
  }

  reply.request.log.error(err, 'Unhandled database error')
  return reply.status(500).send({
    error: 'Internal server error',
    message: 'An unexpected database error occurred',
  })
}
