import { appRegionsFromArgs, cardCheckoutOptionsFromArgs, flag, orgCreationTermsFromArgs, positionals } from "./cli-args.js";
import { createSetupClient } from "./setup-client.js";
import { redactForTransport } from "./redact-transport.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(redactForTransport(value), null, 2));
}

function usage(): never {
  console.error(`Usage:
  clavis login [--bridge-json-file <path>]
  clavis logout
  clavis status
  clavis mcp
  clavis org-anchor-plan <domain> [name] --incorporation CODE --accept-customer-terms
  clavis org-anchor-finish --domain D --nonce N --exp E --ticket T --well-known-url U --txt-host H
  clavis org-verify-anchor --domain D --nonce N --incorporation CODE --accept-customer-terms [--name N]
  clavis policy-bootstrap <orgId>
  clavis incorporation-set <orgId> --incorporation CODE --accept-customer-terms
  clavis card-checkout <orgId> --consent-billing-data [--offer meter|bundle] [--lang en|ja]
  clavis app-register --org O --host H --name N [--redirect /done]
  clavis app-host-plan <orgId> <appId>
  clavis app-verify-host <orgId> <appId>
  clavis app-regions-set <orgId> <appId> (--regions JP,US | --all)
  clavis declaration-set --org O --app A --end-users TEXT --use signature=OP
  clavis emit-env --app A

login: opens developers /setup/login, then paste the JSON from the page (or pass --bridge-json-file).
Do not pass the access token or operate private key as a command-line argument.
org-anchor-plan and org-verify-anchor need both flags. --incorporation is the Org's place of incorporation: JP, GB-EAW, an EEA country code, or US-XX.
--accept-customer-terms records that the customer agrees to the Customer Terms and the DPA for this Org. That is the customer's decision: pass it only after they agree. It is never on by default.
A place of incorporation that is closed to new Orgs right now is refused before Passkey.
incorporation-set declares the place again after the Customer Terms change (status shows terms_current false). It needs the customer's agreement too.
card-checkout needs --consent-billing-data: the customer's consent to provide billing data to the payment provider. Run it once without the flag to get the statement to show them.
Secrets stay in ~/.config/clavis/apps/<appId>/ (mode 0600). Command output includes the file path. emit-env needs CLAVIS_TRUST_ROOT set to the Clavis Master public JWK (docs.clavis.nexus); it checks that the trust documents chain to it before writing CLAVIS_TRUST_ROOT for @clavis.nexus/app.
app-regions-set chooses where the App accepts new connections from: JP, US, GB, EEA (comma-separated). --all accepts every region Clavis accepts. People already connected keep using the App.
declaration-set replaces the App's current declaration. Pass every use to keep. status reports the signature card and the place of incorporation. Ledger subscription is on developers.

Env: CLAVIS_API_ORIGIN CLAVIS_ID_ORIGIN CLAVIS_DEVELOPERS_ORIGIN CLAVIS_SESSION_PATH
`);
  process.exit(2);
}

function requireFlag(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) {
    console.error(`missing ${name}`);
    usage();
  }
  return v;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const client = createSetupClient();

  switch (cmd) {
    case "mcp": {
      const { runMcpServer } = await import("./mcp-server.js");
      await runMcpServer();
      return;
    }
    case "login": {
      if (flag(rest, "--bridge-json")) {
        console.error(
          "refusing --bridge-json: the access token would be visible in the process list. Use --bridge-json-file or paste on stdin.",
        );
        process.exit(2);
      }
      const fromFile = flag(rest, "--bridge-json-file");
      let bridgeJson: string | undefined;
      if (fromFile) {
        const { readFile } = await import("node:fs/promises");
        bridgeJson = await readFile(fromFile, "utf8");
      }
      printJson(await client.login(bridgeJson ? { bridgeJson } : undefined));
      return;
    }
    case "logout":
      printJson(await client.logout());
      return;
    case "status":
      printJson(await client.status());
      return;
    case "org-anchor-plan": {
      const [domain, name] = positionals(rest, ["--incorporation"]);
      if (!domain) usage();
      printJson(await client.orgAnchorPlan(domain, name, orgCreationTermsFromArgs(rest)));
      return;
    }
    case "org-anchor-finish":
      printJson(
        await client.orgAnchorFinish({
          domain: requireFlag(rest, "--domain"),
          nonce: requireFlag(rest, "--nonce"),
          exp: Number(requireFlag(rest, "--exp")),
          ticket: requireFlag(rest, "--ticket"),
          well_known_url: requireFlag(rest, "--well-known-url"),
          txt_host: requireFlag(rest, "--txt-host"),
        }),
      );
      return;
    case "org-verify-anchor":
      printJson(
        await client.orgVerifyAnchor({
          domain: requireFlag(rest, "--domain"),
          nonce: requireFlag(rest, "--nonce"),
          name: flag(rest, "--name"),
          ...orgCreationTermsFromArgs(rest),
        }),
      );
      return;
    case "policy-bootstrap": {
      const orgId = rest[0];
      if (!orgId) usage();
      printJson(await client.policyBootstrap(orgId));
      return;
    }
    case "incorporation-set": {
      const [orgId] = positionals(rest, ["--incorporation"]);
      if (!orgId) usage();
      printJson(await client.incorporationSet({ orgId, ...orgCreationTermsFromArgs(rest) }));
      return;
    }
    case "card-checkout": {
      const [orgId] = positionals(rest, ["--offer", "--lang"]);
      if (!orgId) usage();
      const opts = cardCheckoutOptionsFromArgs(rest);
      if (!opts.ok) {
        console.error(opts.error);
        usage();
      }
      printJson(await client.cardCheckout(orgId, opts.options));
      return;
    }
    case "app-register":
      printJson(
        await client.appRegister({
          orgId: requireFlag(rest, "--org"),
          host: requireFlag(rest, "--host"),
          displayName: requireFlag(rest, "--name"),
          redirectPaths: flag(rest, "--redirect") ? [flag(rest, "--redirect")!] : undefined,
        }),
      );
      return;
    case "app-host-plan": {
      const [orgId, appId] = rest;
      if (!orgId || !appId) usage();
      printJson(await client.appHostPlan(orgId, appId));
      return;
    }
    case "app-verify-host": {
      const [orgId, appId] = rest;
      if (!orgId || !appId) usage();
      printJson(await client.appVerifyHost({ orgId, appId }));
      return;
    }
    case "app-regions-set": {
      const [orgId, appId] = positionals(rest, ["--regions"]);
      if (!orgId || !appId) usage();
      const choice = appRegionsFromArgs(rest);
      if (!choice.ok) {
        console.error(choice.error);
        usage();
      }
      printJson(await client.appRegionsSet({ orgId, appId, regions: choice.regions }));
      return;
    }
    case "declaration-set": {
      const useRaw = requireFlag(rest, "--use");
      const [capability, ...opParts] = useRaw.split("=");
      const operation = opParts.join("=");
      if (!capability || !operation) usage();
      printJson(
        await client.declarationSet({
          orgId: requireFlag(rest, "--org"),
          appId: requireFlag(rest, "--app"),
          endUsers: requireFlag(rest, "--end-users"),
          uses: [{ capability, operation }],
        }),
      );
      return;
    }
    case "emit-env":
      if (flag(rest, "--operate-jwk")) {
        console.error(
          "refusing --operate-jwk: the private key would be visible in the process list. app-register saves it under ~/.config/clavis/apps/.",
        );
        process.exit(2);
      }
      printJson(
        await client.emitEnv({
          appId: requireFlag(rest, "--app"),
        }),
      );
      return;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
