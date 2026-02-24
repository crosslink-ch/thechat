import { listCredentials, resolveCredential } from "../credentials";
import { requestPermission } from "../permission";
import { defineTool } from "./define";

export const getCredentialTool = defineTool({
  name: "get_credential",
  description: `Request access to a credential by name. The user will be prompted for permission before the value is returned.
Use list_credentials first to discover available credentials.
You must provide a reason explaining why you need the credential.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The credential name (from list_credentials)",
      },
      reason: {
        type: "string",
        description: "Why you need this credential",
      },
    },
    required: ["name", "reason"],
  },
  execute: async (args, context) => {
    const { name, reason } = args as { name: string; reason: string };

    // Validate credential exists before prompting user
    const available = listCredentials();
    if (!available.some((c) => c.name === name)) {
      throw new Error(
        `Unknown credential: ${name}. Available: ${available.map((c) => c.name).join(", ") || "none"}`,
      );
    }

    await requestPermission({
      command: `get_credential: ${name}`,
      description: reason,
      convId: context?.convId,
    });

    return await resolveCredential(name);
  },
});
