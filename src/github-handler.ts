import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, Props } from "./utils";
import { clientIdAlreadyApproved, parseRedirectApproval, renderApprovalDialog } from "./workers-oauth-utils";

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  AI: any;
  OAUTH_PROVIDER: OAuthHelpers;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await clientIdAlreadyApproved(c.req.raw, oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    return redirectToGithub(c.req.raw, oauthReqInfo, c.env);
  }

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    server: {
      name: "Cloudflare GitHub MCP Server",
      logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
      description: "This is a demo MCP Remote Server using GitHub for authentication.",
    },
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  const { state, headers } = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY);
  if (!state.oauthReqInfo) {
    return c.text("Invalid request", 400);
  }

  return redirectToGithub(c.req.raw, state.oauthReqInfo, c.env, headers);
});

async function redirectToGithub(
  request: Request, 
  oauthReqInfo: AuthRequest, 
  env: Env,
  headers: Record<string, string> = {}
) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        upstream_url: "https://github.com/login/oauth/authorize",
        scope: "read:user",
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: new URL("/callback", request.url).href,
        state: btoa(JSON.stringify(oauthReqInfo)),
      }),
    },
  });
}

/**
 * OAuth Callback Endpoint
 */
app.get("/callback", async (c) => {
  try {
    const stateParam = c.req.query("state");
    if (!stateParam) {
      return c.text("Missing state parameter", 400);
    }

    const oauthReqInfo = JSON.parse(atob(stateParam)) as AuthRequest;
    if (!oauthReqInfo.clientId) {
      return c.text("Invalid state", 400);
    }

    // Exchange the code for an access token
    const [accessToken, errResponse] = await fetchUpstreamAuthToken({
      upstream_url: "https://github.com/login/oauth/access_token",
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code: c.req.query("code"),
      redirect_uri: new URL("/callback", c.req.url).href,
    });
    if (errResponse) return errResponse;

    // Fetch the user info from GitHub
    const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
    const { login, name, email } = user.data;

    // Return back to the MCP client a new token
    const normalizedLogin = login.toLowerCase().trim();
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: normalizedLogin,
      metadata: {
        label: name,
      },
      scope: oauthReqInfo.scope,
      // This will be available on this.props inside MyMCP
      props: {
        login: normalizedLogin,
        name,
        email,
        accessToken,
      } as Props,
    });

    return Response.redirect(redirectTo);
  } catch (error) {
    console.error("Callback error:", error);
    return c.text("Invalid request", 400);
  }
});

export { app as GitHubHandler };