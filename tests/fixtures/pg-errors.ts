export function makeUniqueViolation (detail?: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    detail: detail ?? 'Key (email)=(alice@test.com) already exists.',
    constraint: 'users_email_key',
  })
}

export function makeFkViolation (detail?: string) {
  return Object.assign(new Error('insert or update on table violates foreign key constraint'), {
    code: '23503',
    detail: detail ?? 'Key (user_id)=(999) is not present in table "users".',
    constraint: 'orders_user_id_fkey',
  })
}

export function makeNotNullViolation (detail?: string) {
  return Object.assign(new Error('null value in column violates not-null constraint'), {
    code: '23502',
    detail: detail ?? 'Failing row contains (null, ...).',
    constraint: 'users_name_not_null',
  })
}

export function makeInvalidInput (detail?: string) {
  return Object.assign(new Error('invalid input syntax for type integer'), {
    code: '22P02',
    detail: detail ?? undefined,
    constraint: undefined,
  })
}

export function makeUnknownPgError () {
  return Object.assign(new Error('syntax error at or near'), {
    code: '42601',
    detail: undefined,
    constraint: undefined,
  })
}
