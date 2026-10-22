import { z } from "zod";
import { SECURE_INPUT_KINDS } from "@thechat/shared";
import { vaultUnlockRequestSchema, vaultUnlockResolvedSchema, vaultUnlockResponseSchema, validateVaultPublicKey } from "./vault-unlock";
import { ServiceError } from "./errors";

const safe = (max: number) => z.string().min(1).max(max).refine(v => v === v.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const uuid = z.string().uuid().refine(v => v === v.toLowerCase());
export const secureInputRequestSchema = vaultUnlockRequestSchema.omit({ backend: true }).extend({
  version: z.literal(3), requestId: uuid, sessionKey: safe(1000), profileId: safe(255), requesterUserId: safe(255),
  promptKind: z.enum(["onepassword.unlock", "vault.save_login", "vault.code", "sudo.password", "skill.secret"]),
  fields: z.array(z.enum(["identifier", "password", "code", "value"])).min(1).max(2),
  target: safe(2000),
}).strict().superRefine((r, ctx) => {
  if (JSON.stringify(r.fields) !== JSON.stringify(SECURE_INPUT_KINDS[r.promptKind].fields)) ctx.addIssue({ code: "custom", message: "Invalid secure input fields" });
  if (r.promptKind === "onepassword.unlock" && r.target !== "1Password") ctx.addIssue({ code: "custom", message: "Invalid target" });
  if (r.promptKind === "skill.secret" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.target)) ctx.addIssue({ code: "custom", message: "Invalid target" });
  if (r.promptKind === "vault.save_login") {
    try { const u = new URL(r.target); if (!["https:", "http:"].includes(u.protocol) || u.origin !== r.target || u.username || u.password) throw new Error(); }
    catch { ctx.addIssue({ code: "custom", message: "Invalid target" }); }
  }
  try { validateVaultPublicKey(r.publicKeySpkiB64); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid public key" }); }
});
export const secureInputResolvedSchema = vaultUnlockResolvedSchema.extend({ version: z.literal(3), requestId: uuid, sessionKey: safe(1000) }).strict();
const ciphertext = z.string().max(21868).refine(v => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) return false;
  const b = Buffer.from(v, "base64");
  return b.length >= 17 && b.length <= 16400 && b.toString("base64") === v;
});
export const secureInputResponseSchema = z.discriminatedUnion("action", [
  vaultUnlockResponseSchema.options[0].extend({ version: z.literal(3), ciphertextB64: ciphertext }).strict(),
  z.object({ version: z.literal(3), action: z.literal("cancel") }).strict(),
]);
export function secureInputError(status: number) { return new ServiceError("Could not deliver the secure input response", status); }
