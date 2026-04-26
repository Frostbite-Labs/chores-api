# Google OAuth setup

How to provision the `GOOGLE_CLIENT_ID` env var that the API uses to verify
Google ID tokens posted to `POST /v1/auth/google`.

The server validates `aud === GOOGLE_CLIENT_ID` exactly
(`api/src/modules/auth/google.verifier.ts`), so whatever you set here must
match the `aud` claim on every ID token the mobile client sends.

> **No client secret is required.** The mobile client performs the OAuth flow
> natively and posts an ID token to `/v1/auth/google`; the server only verifies
> that token's signature against Google's public JWKS. The server never calls
> Google's token endpoint, so it never needs a client secret. (iOS and Android
> OAuth clients in Google Cloud Console don't even have one - only the Web
> client type does, and we still wouldn't use it here.)

## 1. Google Cloud Console - one-time

1. Open <https://console.cloud.google.com/> and create a project (or pick an existing one).
2. **APIs & Services → OAuth consent screen** - set User type (External for a public app), fill app name + support email, save. You can stay in **Testing** mode while developing; just add your Google account as a test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.

## 2. Pick a client-ID strategy

The server accepts a single `aud`, so the mobile client needs to send tokens
whose `aud` matches `GOOGLE_CLIENT_ID`. With Expo + `expo-auth-session` the
standard pattern is:

- Create a **Web application** OAuth client → use this client ID as `GOOGLE_CLIENT_ID` on the server.
- Create **iOS** and **Android** OAuth clients for the native sign-in flow (they need bundle ID / package name + SHA-1 fingerprint).
- In the Expo client, pass the **Web** client ID as the `clientId` / `webClientId` parameter so the issued ID token has `aud` = that web client ID. iOS/Android clients are still required for the OAuth handshake, but the audience is the web one.

If you only ever target one platform you can skip the others and use that
platform's client ID directly as `GOOGLE_CLIENT_ID`. The moment you add a
second platform you'll need to either move to the web-client-as-audience
pattern above, or extend `google.verifier.ts` + `env.ts` to accept an array of
client IDs.

## 3. Wire it into the API

Local (the `docker-compose.local.yml` passes `GOOGLE_CLIENT_ID` through from
the shell):

```bash
export GOOGLE_CLIENT_ID="123456789-abc...apps.googleusercontent.com"
docker compose -f docker-compose.local.yml up --build
```

Or persist it in `api/.env` (gitignored) for `npm run dev` outside Docker.

For live, put it in your `.env.live` file alongside the Apple OAuth values and
reference it via `docker compose -f docker-compose.live.yml --env-file .env.live up -d`.

## 4. Sanity check

Decode an incoming token with [jwt.io](https://jwt.io) or `jose` and confirm:

- `iss` is `https://accounts.google.com` (or `accounts.google.com`)
- `aud` matches your `GOOGLE_CLIENT_ID` exactly
- `email_verified` is `true` if you intend to use the email for invite matching

A mismatch surfaces as `401` with `code: auth.google.invalid_token`.
