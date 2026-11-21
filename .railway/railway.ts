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
 * use it at all, so this is the only Railway config Sushi ships.
 *
 * Apply it with the Railway CLI (the SDK is needed only to evaluate this file,
 * which is why it is installed with --no-save and not added to package.json):
 *
 *   npm i -g @railway/cli
 *   railway login
 *   railway init            # or: railway link   (existing project)
 *   npm i --no-save railway
 *   railway config plan     # preview
 *   railway config apply    # create both services
 *   railway variable set SUSHI_GATEWAY_TOKEN="$(openssl rand -hex 24)" --service sushi-gateway
 *   railway variable set ALLOWED_ORIGIN="https://your-app.vercel.app" --service sushi-gateway
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
      // Set once on Railway (`railway variable set …` or the Variables tab) and
      // kept there: preserve() means "do not overwrite what Railway holds", so a
      // secret never has to live in this file.
      //   SUSHI_GATEWAY_TOKEN → paste into Sushi → Gateway settings
      //   ALLOWED_ORIGIN      → this Vercel app's exact origin, no trailing slash
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
