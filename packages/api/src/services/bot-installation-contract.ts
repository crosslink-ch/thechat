import { z } from "zod";
export const botInstallationInputSchema = z
  .object({
    enabled: z.boolean(),
    channelScope: z.enum(["all", "selected"]),
    conversationIds: z.array(z.string().uuid()).max(500),
    attachmentAccess: z.boolean(),
    sharedRuntimeConsent: z.boolean(),
    approveEndpoint: z.boolean().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
