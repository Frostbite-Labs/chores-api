import { z } from 'zod';

export const leaderboardQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  tz: z.string().max(80).optional(),
});

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
