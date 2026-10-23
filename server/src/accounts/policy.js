// @ts-check
// The numbers of an email code, in a module with no database behind it: the store enforces them, the verification email and the
// sign-up answers state them, and a script (scripts/mail-test.mjs) can build that email without opening a database.
export const CODE_MINUTES = 10;
export const CODE_ATTEMPTS = 5;
