-- Drop the UNIQUE constraint on users.email.
--
-- With cross-provider auto-linking removed (each new (provider, sub) creates
-- its own user), two distinct people who happen to share an email at different
-- providers must be able to coexist as separate user rows. UNIQUE on email
-- would block the second sign-up entirely. Identity is now (provider, sub) on
-- user_identities; email is a display attribute.
ALTER TABLE users DROP INDEX uq_users_email;
ALTER TABLE users ADD KEY idx_users_email (email);
