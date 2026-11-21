# One-time Railway template setup for the Sushi gateway

This is a **recipe, not an existing Railway template**. A Railway workspace owner
must create it once in Railway's template composer. Future **new projects deployed
from that template** are intended to receive their own generated gateway token;
normal service restarts and redeploys should keep it. This does not change an
existing service, create a template by itself, or automatically connect a
separately hosted Sushi UI. Creating test deployments may incur Railway charges.

Do not paste the template variables into a live service or import the full-app
`.env.example`: doing so could replace existing settings or tokens. The `${{secret(...)}}`
function is a **template** function, not a command to paste into an ordinary
service's Variables. Do not use a real token in the template or repository.

## Create the template once

1. Open your Railway workspace's [Templates](https://railway.com/workspace/templates)
   page, choose **New Template**, and start from scratch—not from your existing
   project. See [Railway's template instructions](https://docs.railway.com/templates/create).
2. Add a Docker image service named exactly **`guacd`**, using
   `guacamole/guacd:1.5.5`. Keep public HTTP networking and any TCP proxy **off**:
   guacd has no authentication, so only trusted services should share its private
   project environment. In its **Settings**, set the start command to
   `/opt/guacamole/sbin/guacd -b :: -L info -f`, so it can listen on Railway's
   private IPv6 network as well as IPv4 where dual-stack is supported. Do not
   configure an HTTP health check for guacd.
3. Add a GitHub service named **`sushi-gateway`**, sourced from
   `https://github.com/sarakplaystore/sushi`. The chosen branch must already
   include this guide, `gateway-template-variables.json` and the token format
   guard in `server.ts`. Use `main` once these changes are merged, or a published
   branch containing them. The root `Dockerfile` is for the full app; the
   variables below select `Dockerfile.gateway` instead.
4. In the **template composer's** `sushi-gateway` → **Variables → Raw Editor →
   JSON**, paste the complete contents of
   [`gateway-template-variables.json`](gateway-template-variables.json). The same
   JSON can be copied from Sushi's **Settings → Gateway → Railway → Need to
   deploy a gateway?** panel. Save/update the variables and apply staged template
   changes if prompted. This is a complete set for a **new template service**;
   do not use it to replace variables in an existing service. If the composer has
   no JSON editor, add the keys and their `value` fields individually there.
   - Leave `SUSHI_GATEWAY_TOKEN` as the symbolic
     `${{secret(48, "abcdef0123456789")}}` expression in the template. Railway
     should evaluate it when someone deploys the template, not when the
     container restarts. `SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48=true` makes the
     updated gateway reject a blank or unevaluated token at startup; it checks
     format only, not randomness.
   - The default `ALLOWED_ORIGIN` is `https://sushi-lyart-three.vercel.app`.
     Change it to the exact HTTPS origin of another Sushi frontend, without a
     path or trailing slash. The `GUACD_HOST` reference assumes the service is
     named `guacd`.
5. In `sushi-gateway` **Settings**, enable **HTTP Public Networking** with
   target port **3000**, and set the health-check path to
   `/api/system/capabilities` (timeout 120 seconds). Do not enable public
   networking on `guacd`. Finish with **Create Template**, then copy the
   template's actual share/deploy URL from Railway. Publishing in the public
   marketplace is separate and is not required for a shareable template.

A file in this repository does not register a Railway template or create a
working deploy button. Do not add a button until the real template exists and
has been tested. Railway may still require **Generate Domain** under a deployed
gateway's **Settings → Networking → Public Networking**, using port 3000.

## Verify before relying on it

1. From the saved template URL, deploy **two new disposable test projects**;
   do not target an existing gateway. In each `sushi-gateway` → **Variables**,
   privately check that `SUSHI_GATEWAY_TOKEN` is 48 lowercase hexadecimal
   characters, not blank or the literal expression, and that the two values
   differ. Check `SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48` is `true`. Do not post the
   values, log them, or include them in screenshots. If a value is missing,
   literal, or duplicated, stop using the new services and repair the template;
   a public, predictable credential is unsafe.
2. Redeploy or restart one test gateway and verify its token remains the same.
   Confirm the gateway has a public HTTPS domain and that `guacd` has no public
   domain or TCP proxy. The gateway's `/api/system/capabilities` can report
   `rdpGuacd: true` when the private guacd connection succeeds; check a real RDP
   session too if you need live RDP. Network and provider behavior must be
   verified in Railway, not inferred from this recipe.
3. In Sushi **Settings → Gateway**, enter the new gateway's HTTPS base URL and
   the matching generated token **privately**, then save and open a real SSH
   session. The **Test Gateway Endpoint** button checks public HTTP only; it
   does not validate the token or WebSocket. The template cannot send its
   generated secret automatically into the separate Sushi browser. Gateway
   settings are stored in this browser's local storage, so repeat the private
   setup for other browsers/devices as needed.

Railway's [sealed variables](https://docs.railway.com/variables#sealed-variables)
cannot be read back, even via the API. Keep a secure copy before sealing. If a
token is already sealed and its value is lost, deliberate rotation and updates
to **every** gateway client are necessary; do not overwrite it just to set up
the template. When the format guard is enabled, a replacement must also be a
cryptographically random 48-character lowercase hex value. Remove only the
new disposable test projects when finished, if desired.
