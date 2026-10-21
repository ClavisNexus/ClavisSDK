import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { createSetupClient } from "./setup-client.js";
import type { SetupClient } from "./setup-client.js";
import type { OrgCreationTerms } from "./org-creation.js";
import { APP_REGIONS, chooseAppRegions } from "./app-regions.js";
import { checkoutLang } from "./card.js";
import { redactForTransport } from "./redact-transport.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json") as { version: string };

const ORG_CREATION_PROPERTIES = {
  incorporation: {
    type: "string",
    description:
      "Place of incorporation the customer declares for the Org: JP, GB-EAW, an EEA country code (e.g. DE), or US-XX (e.g. US-DE).",
  },
  accept_customer_terms: {
    type: "boolean",
    description:
      "true only after the customer (a human) has agreed to the Customer Terms and the Data Processing Agreement for this Org. Ask them; never set it on their behalf.",
  },
} as const;

const TOOLS = [
  {
    name: "clavis_setup_status",
    description:
      "List Org, App, signature card (with what holds it back), place of incorporation, and declaration readiness for the logged-in developers session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "clavis_login",
    description:
      "Start or finish developers Passkey login. First call opens the browser; after the human pastes the page JSON, call again with bridge_json.",
    inputSchema: {
      type: "object",
      properties: {
        bridge_json: {
          type: "string",
          description: "JSON shown on developers /setup/login after Passkey (state + accessToken).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "clavis_org_anchor_plan",
    description:
      "Start the Org DNS anchor challenge and open Passkey confirmation. Needs the place of incorporation and the customer's agreement to the Customer Terms; a place closed to new Orgs is refused before Passkey. Returns a ticket and human action.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        name: { type: "string" },
        ...ORG_CREATION_PROPERTIES,
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_org_anchor_finish",
    description: "After Passkey, build well-known JSON and TXT values for the Org apex domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        nonce: { type: "string" },
        exp: { type: "number" },
        ticket: { type: "string" },
        well_known_url: { type: "string" },
        txt_host: { type: "string" },
      },
      required: ["domain", "nonce", "exp", "ticket", "well_known_url", "txt_host"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_org_verify_anchor",
    description:
      "Verify the Org DNS anchor after TXT and well-known are published, and create the Org. Pass the same incorporation and the customer's agreement to the Customer Terms as org_anchor_plan.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        nonce: { type: "string" },
        name: { type: "string" },
        ...ORG_CREATION_PROPERTIES,
      },
      required: ["domain", "nonce"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_policy_bootstrap",
    description: "Create the Org policy. Opens Passkey when the policy is not yet active.",
    inputSchema: {
      type: "object",
      properties: { org_id: { type: "string" } },
      required: ["org_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_incorporation_set",
    description:
      "Declare the Org's place of incorporation again (Passkey). Needed before card checkout when status shows incorporation null or terms_current false. The declaration binds the current Customer Terms and DPA, so it needs the customer's agreement.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        ...ORG_CREATION_PROPERTIES,
      },
      required: ["org_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_card_checkout",
    description:
      "Open the checkout URL for the signature card (Passkey). Needs a current place of incorporation and the customer's consent to provide billing data to the payment provider. Call once without consent_billing_data to get the consent statement, show it to the customer, and call again only if they consent.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        offer: {
          type: "string",
          enum: ["meter", "bundle"],
          description: "meter (pay per use, default) or bundle (monthly bundle).",
        },
        lang: {
          type: "string",
          enum: ["en", "ja"],
          description: "Language of the consent statement shown to the customer (default en). The purchase record keeps this language.",
        },
        consent_billing_data: {
          type: "boolean",
          description:
            "true only after the customer (a human) has read the consent statement and consented. Ask them; never set it on their behalf.",
        },
      },
      required: ["org_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_app_register",
    description:
      "Register an App and generate an operate key (Passkey). Saves the private key under ~/.config/clavis/apps/<appId>/ (mode 0600) and returns that file path.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        host: { type: "string" },
        display_name: { type: "string" },
        redirect_path: { type: "string" },
      },
      required: ["org_id", "host", "display_name"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_app_host_plan",
    description: "Return the App host TXT challenge for DNS publish.",
    inputSchema: {
      type: "object",
      properties: { org_id: { type: "string" }, app_id: { type: "string" } },
      required: ["org_id", "app_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_app_verify_host",
    description: "Verify the App host after TXT is published (Passkey).",
    inputSchema: {
      type: "object",
      properties: { org_id: { type: "string" }, app_id: { type: "string" } },
      required: ["org_id", "app_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_app_regions_set",
    description:
      "Choose the regions the App accepts new connections from (Passkey). Pass regions, or all: true to accept every region Clavis accepts. People already connected keep using the App. A region Clavis does not accept right now is refused before Passkey.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        app_id: { type: "string" },
        regions: {
          type: "array",
          items: { type: "string", enum: [...APP_REGIONS] },
          minItems: 1,
          description: "JP, US, GB, EEA. New connections from anywhere else are refused.",
        },
        all: {
          type: "boolean",
          description: "true to accept every region Clavis accepts (removes the App's list).",
        },
      },
      required: ["org_id", "app_id"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_declaration_set",
    description:
      "Replace the App use declaration (Passkey). uses becomes the whole declaration. Include every capability to keep. Signature requests need a signature use.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        app_id: { type: "string" },
        end_users: { type: "string" },
        uses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              capability: { type: "string" },
              operation: { type: "string" },
            },
            required: ["capability", "operation"],
          },
        },
      },
      required: ["org_id", "app_id", "end_users", "uses"],
      additionalProperties: false,
    },
  },
  {
    name: "clavis_emit_app_env",
    description: "Emit environment variables for @clavis.nexus/app after setup. Needs CLAVIS_TRUST_ROOT (the Clavis Master public JWK) in the environment.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
      },
      required: ["app_id"],
      additionalProperties: false,
    },
  },
] as const;

/** Agreement counts only when the argument is boolean true. */
function orgCreationTerms(args: Record<string, unknown>): OrgCreationTerms {
  return {
    incorporation: typeof args.incorporation === "string" ? args.incorporation : undefined,
    acceptCustomerTerms: args.accept_customer_terms === true,
  };
}

async function dispatch(client: SetupClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "clavis_setup_status":
      return client.status();
    case "clavis_login":
      return client.login(
        args.bridge_json ? { bridgeJson: String(args.bridge_json) } : undefined,
      );
    case "clavis_org_anchor_plan":
      return client.orgAnchorPlan(
        String(args.domain),
        args.name ? String(args.name) : undefined,
        orgCreationTerms(args),
      );
    case "clavis_org_anchor_finish":
      return client.orgAnchorFinish({
        domain: String(args.domain),
        nonce: String(args.nonce),
        exp: Number(args.exp),
        ticket: String(args.ticket),
        well_known_url: String(args.well_known_url),
        txt_host: String(args.txt_host),
      });
    case "clavis_org_verify_anchor":
      return client.orgVerifyAnchor({
        domain: String(args.domain),
        nonce: String(args.nonce),
        name: args.name ? String(args.name) : undefined,
        ...orgCreationTerms(args),
      });
    case "clavis_policy_bootstrap":
      return client.policyBootstrap(String(args.org_id));
    case "clavis_incorporation_set":
      return client.incorporationSet({ orgId: String(args.org_id), ...orgCreationTerms(args) });
    case "clavis_card_checkout":
      return client.cardCheckout(String(args.org_id), {
        offer: args.offer === "bundle" ? "bundle" : "meter",
        lang: checkoutLang(args.lang),
        consentBillingData: args.consent_billing_data === true,
      });
    case "clavis_app_register":
      return client.appRegister({
        orgId: String(args.org_id),
        host: String(args.host),
        displayName: String(args.display_name),
        redirectPaths: args.redirect_path ? [String(args.redirect_path)] : undefined,
      });
    case "clavis_app_host_plan":
      return client.appHostPlan(String(args.org_id), String(args.app_id));
    case "clavis_app_verify_host":
      return client.appVerifyHost({ orgId: String(args.org_id), appId: String(args.app_id) });
    case "clavis_app_regions_set": {
      const choice = chooseAppRegions({
        ...(args.regions !== undefined
          ? { regions: Array.isArray(args.regions) ? args.regions.map((code) => String(code)) : [] }
          : {}),
        all: args.all === true,
      });
      if (!choice.ok) return choice;
      return client.appRegionsSet({ orgId: String(args.org_id), appId: String(args.app_id), regions: choice.regions });
    }
    case "clavis_declaration_set":
      return client.declarationSet({
        orgId: String(args.org_id),
        appId: String(args.app_id),
        endUsers: String(args.end_users),
        uses: args.uses as { capability: string; operation: string }[],
      });
    case "clavis_emit_app_env":
      return client.emitEnv({
        appId: String(args.app_id),
      });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function runMcpServer(): Promise<void> {
  const client = createSetupClient();
  const server = new Server({ name: "clavis-setup", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await dispatch(client, name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(redactForTransport(result), null, 2) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { runMcpServer };
