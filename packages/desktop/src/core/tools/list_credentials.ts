import { listCredentials } from "../credentials";
import { defineTool } from "./define";

export const listCredentialsTool = defineTool({
  name: "list_credentials",
  description: `List available credentials (API tokens, keys) that you can request access to.
Returns credential names, descriptions, and types — no secret values.
Use get_credential to request a specific credential (requires user permission).`,
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: () => {
    const credentials = listCredentials();
    return { credentials, total: credentials.length };
  },
});
