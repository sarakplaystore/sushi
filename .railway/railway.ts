/**
 * Railway project for the Sushi gateway: the persistent WebSocket process that a
 * Vercel-hosted Sushi UI attaches to for native PTY shells (`vim`, `htop`,
 * `tmux`, resize, team-shared sessions) and guacd-backed live RDP.
 *
 * Two services, one private network:
 *   sushi-gateway  → Dockerfile.gateway (server.ts with GATEWAY_ONLY=true)
 *   guacd          → guacamole/guacd, reached over Railway's private network
 *
 * Railway replaced `railway.json` / `railway.toml` (Config as Code) with this
 * file; Config as Code stops being read on 2026-12-01 and new services cannot
 * use it at all, so this is Sushi's Railway IaC configuration.
 *
 * Alternatively, .railway/TEMPLATE.md describes creating a Railway template
 * once for future new deployments with generated tokens. Its variable JSON is
 * for the template composer only, not an existing live service; it does not
 * register a template or change anything on Railway by itself.
 *
 * Apply it to a new, dedicated Railway project (the SDK is needed only to
 * evaluate this file, so it is installed with --no-save).
 * IMPORTANT: This file manages the entire selected environment. Applying it can
 * delete resources and variables not listed here. Review the plan and cancel
 * unintended changes. For an existing gateway, link it and run the helper
 * without --apply to avoid changing other resources.
 *
 *   npm i -g @railway/cli
 *   railway login
 *   railway init            # new, dedicated project
 *   railway status          # verify linked project and environment
 *   npm i --no-save railway@3.17.0
 *   env -u _ railway config plan   # preview; works around SDK _ handling
 *   node scripts/provision-gateway.mjs railway --apply
 *
 * The helper runs railway config apply with confirmation, then creates only
 * missing gateway variables. Railway CLI 5.47.2+ is required to recognize
 * sealed values; --apply with --environment requires 5.64.0+. For a new
 * non-default frontend add --origin https://your-app.vercel.app. Existing values
 * (including sealed secrets) are never deliberately rotated; don't edit these
 * variables concurrently while the helper is running.
 *
 * Then give sushi-gateway a public HTTPS domain — the service's Settings →
 * Networking → Generate Domain — and paste that URL plus the token into
 * Sushi → Gateway settings. Generated domains are not declared here on purpose.
 *
 * Dashboard instead of the CLI: New Project → GitHub Repo → this repository,
 * set Build Configuration → Dockerfile Path to `Dockerfile.gateway`, add a
 * second service from the Docker image `guacamole/guacd:1.5.5`, set
 * GUACD_HOST to that service's RAILWAY_PRIVATE_DOMAIN, then generate a domain.
 */
import { defineRailway, github, group, image, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  // Apache Guacamole's protocol proxy. Sushi's gateway speaks to it over TCP
  // 4822 to render live Windows / xrdp desktops in the browser. Without it the
  // gateway still serves the full SSH PTY, and RDP falls back to the browser's
  // IronRDP WebAssembly client.
  const guacd = service("guacd", {
    source: image("guacamole/guacd:1.5.5"),
    env: {
      GUACD_LOG_LEVEL: "info",
    },
  });

  const gateway = service("sushi-gateway", {
    source: github("sarakplaystore/sushi"),
    start: "npm run gateway",
    healthcheck: "/api/system/capabilities",
    healthcheckTimeout: 120,
    env: {
      GATEWAY_ONLY: "true",
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      // The repo's root Dockerfile builds the whole app (web + gateway), so point
      // this service at the slim gateway-only image instead.
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.gateway",
      // Typed cross-service reference: resolves to guacd's private DNS name.
      GUACD_HOST: guacd.env.RAILWAY_PRIVATE_DOMAIN,
      GUACD_PORT: "4822",
      // preserve() does NOT generate a value. The provisioning helper creates
      // missing values once after apply, then future applies leave them alone.
      // On a dashboard-only deploy, set a secure token manually. The gateway
      // supplies its default origin when ALLOWED_ORIGIN is absent.
      //   SUSHI_GATEWAY_TOKEN → paste privately into Sushi → Gateway settings
      //   ALLOWED_ORIGIN      → the frontend's exact origin, no trailing slash
      // Both live under sushi-gateway → Variables (https://railway.com/dashboard,
      // and https://docs.railway.com/variables for how Railway variables work).
      SUSHI_GATEWAY_TOKEN: preserve(),
      ALLOWED_ORIGIN: preserve(),
    },
  });

  // Generated Railway domains are deliberately not declared here (Railway keeps
  // them out of this file); create the public HTTPS/WSS domain in the service's
  // Settings → Networking → Generate Domain and paste it into Sushi → Gateway
  // settings.
  return project("sushi-gateway", {
    resources: [group("Sushi Gateway", [gateway, guacd])],
  });
});
