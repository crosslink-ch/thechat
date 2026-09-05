import { z } from "zod";

// Blank input is meaningful only for settings retention; creation adds min(1).
export const hermesGatewayTokenSchema = z
  .string()
  .max(4096)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Invalid Hermes gateway token",
  )
  .trim()
  .regex(/^\S*$/, "Invalid Hermes gateway token");
