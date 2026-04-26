import { z } from 'zod';

export const googleSignInSchema = z.object({
  idToken: z.string().min(20),
  deviceLabel: z.string().max(120).optional(),
});

export const appleNonceResponseSchema = z.object({
  nonce: z.string(),
  expiresAt: z.string(),
});

export const appleSignInSchema = z.object({
  identityToken: z.string().min(20),
  /** Server-issued nonce returned by `POST /auth/apple/nonce`. */
  nonce: z.string().min(8),
  deviceLabel: z.string().max(120).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    displayName: z.string(),
    avatar: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

export type GoogleSignInBody = z.infer<typeof googleSignInSchema>;
export type AppleSignInBody = z.infer<typeof appleSignInSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
