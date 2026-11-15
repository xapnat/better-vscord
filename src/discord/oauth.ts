import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const DISCORD_API = "https://discord.com/api/v10";
export const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const SCOPES = "openid sdk.social_layer_presence";

const TOKENS_KEY = "vscord.oauth.tokens";
const CLIENT_SECRET_KEY = "vscord.oauth.clientSecret";
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

export interface SecretStore {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export interface StoredTokens {
    clientId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
}

export interface OAuthOptions {
    secrets: SecretStore;
    redirectPort: number;
    openUrl: (url: string) => Thenable<unknown>;
    askClientSecret: () => Thenable<string | undefined>;
    apiBase?: string;
    authorizeUrl?: string;
}

export class NotAuthorizedError extends Error {
    constructor(message = "Not authorized with Discord") {
        super(message);
        this.name = "NOT_AUTHORIZED";
    }
}

export class OAuthError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        readonly status?: number
    ) {
        super(message);
        this.name = "OAUTH_ERROR";
    }
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body>`;

export class DiscordOAuth {
    private refreshing: Promise<StoredTokens> | undefined;
    private authorizing: Promise<StoredTokens> | undefined;

    constructor(private readonly options: OAuthOptions) {}

    private get apiBase() {
        return this.options.apiBase ?? DISCORD_API;
    }

    get redirectUri() {
        return `http://127.0.0.1:${this.options.redirectPort}/callback`;
    }

    set redirectPort(port: number) {
        this.options.redirectPort = port;
    }

    async readTokens(clientId: string): Promise<StoredTokens | undefined> {
        const raw = await this.options.secrets.get(TOKENS_KEY);
        if (!raw) return undefined;
        try {
            const tokens = JSON.parse(raw) as StoredTokens;
            return tokens.clientId === clientId && tokens.accessToken ? tokens : undefined;
        } catch {
            return undefined;
        }
    }

    private async saveTokens(clientId: string, response: TokenResponse, previous?: StoredTokens) {
        const tokens: StoredTokens = {
            clientId,
            accessToken: response.access_token,
            refreshToken: response.refresh_token ?? previous?.refreshToken,
            expiresAt: Date.now() + (response.expires_in ?? 604800) * 1000
        };
        await this.options.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
        return tokens;
    }

    async hasTokens(clientId: string) {
        return (await this.readTokens(clientId)) !== undefined;
    }

    async getAccessToken(clientId: string, forceRefresh = false): Promise<string> {
        const tokens = await this.readTokens(clientId);
        if (!tokens) throw new NotAuthorizedError();
        if (!forceRefresh && tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
        if (!tokens.refreshToken) {
            if (!forceRefresh && tokens.expiresAt > Date.now()) return tokens.accessToken;
            throw new NotAuthorizedError("Discord authorization expired");
        }

        try {
            return (await this.refresh(tokens)).accessToken;
        } catch (error) {
            if (!(error instanceof NotAuthorizedError) && !forceRefresh && tokens.expiresAt > Date.now())
                return tokens.accessToken;
            throw error;
        }
    }

    private refresh(tokens: StoredTokens): Promise<StoredTokens> {
        this.refreshing ??= this.doRefresh(tokens).finally(() => (this.refreshing = undefined));
        return this.refreshing;
    }

    private async doRefresh(tokens: StoredTokens): Promise<StoredTokens> {
        try {
            const response = await this.tokenRequest(tokens.clientId, {
                grant_type: "refresh_token",
                refresh_token: tokens.refreshToken!
            });
            return await this.saveTokens(tokens.clientId, response, tokens);
        } catch (error) {
            if (!(error instanceof OAuthError) || error.code !== "invalid_grant") throw error;

            // Another VS Code window may have rotated the refresh token in the meantime.
            const current = await this.readTokens(tokens.clientId);
            if (current && current.accessToken !== tokens.accessToken) return current;

            await this.options.secrets.delete(TOKENS_KEY);
            throw new NotAuthorizedError("Discord authorization was revoked or expired");
        }
    }

    private async tokenRequest(clientId: string, params: Record<string, string>): Promise<TokenResponse> {
        const clientSecret = await this.options.secrets.get(CLIENT_SECRET_KEY);
        const body = new URLSearchParams({ client_id: clientId, ...params });
        if (clientSecret) body.set("client_secret", clientSecret);

        const response = await fetch(`${this.apiBase}/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });
        const text = await response.text();
        let json: Record<string, unknown> = {};
        try {
            json = JSON.parse(text) as Record<string, unknown>;
        } catch {}

        if (!response.ok || typeof json.access_token !== "string") {
            const code = typeof json.error === "string" ? json.error : undefined;
            const description = typeof json.error_description === "string" ? json.error_description : text;
            throw new OAuthError(
                `Discord token request failed (${response.status}): ${code ?? ""} ${description}`.trim(),
                code,
                response.status
            );
        }
        return json as unknown as TokenResponse;
    }

    authorize(clientId: string): Promise<StoredTokens> {
        this.authorizing ??= this.doAuthorize(clientId, true).finally(() => (this.authorizing = undefined));
        return this.authorizing;
    }

    private async doAuthorize(clientId: string, allowSecretPrompt: boolean): Promise<StoredTokens> {
        const verifier = base64url(randomBytes(48));
        const challenge = base64url(createHash("sha256").update(verifier).digest());
        const state = base64url(randomBytes(16));
        const redirectUri = this.redirectUri;

        const url = new URL(this.options.authorizeUrl ?? AUTHORIZE_URL);
        url.search = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: redirectUri,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            prompt: "consent"
        })
            .toString()
            .replaceAll("+", "%20");

        const code = await this.waitForCode(url.toString(), state);

        try {
            const response = await this.tokenRequest(clientId, {
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                code_verifier: verifier
            });
            return await this.saveTokens(clientId, response);
        } catch (error) {
            const needsSecret =
                error instanceof OAuthError && (error.code === "invalid_client" || error.status === 401);
            if (!needsSecret || !allowSecretPrompt) throw error;

            const secret = await this.options.askClientSecret();
            if (!secret) throw error;
            await this.options.secrets.store(CLIENT_SECRET_KEY, secret.trim());
            return this.doAuthorize(clientId, false);
        }
    }

    private waitForCode(authorizeUrl: string, state: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let server: Server | undefined;
            let settled = false;

            const finish = (error?: Error, code?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                setTimeout(() => {
                    server?.close();
                    server?.closeAllConnections?.();
                }, 250);
                if (error) reject(error);
                else resolve(code!);
            };

            const timeout = setTimeout(
                () => finish(new OAuthError("Timed out waiting for the Discord authorization", "timeout")),
                AUTHORIZE_TIMEOUT_MS
            );

            server = createServer((request, response) => {
                const url = new URL(request.url ?? "/", this.redirectUri);
                if (url.pathname !== "/callback") {
                    response.writeHead(404).end();
                    return;
                }

                const error = url.searchParams.get("error");
                const code = url.searchParams.get("code");
                response.setHeader("Content-Type", "text/html; charset=utf-8");

                if (url.searchParams.get("state") !== state) {
                    response.writeHead(400).end(page("Authorization failed", "State mismatch. Please try again."));
                    return;
                }
                if (error || !code) {
                    const description = url.searchParams.get("error_description") ?? error ?? "No code received";
                    response.writeHead(400).end(page("Authorization failed", description));
                    finish(new OAuthError(`Discord authorization failed: ${description}`, error ?? undefined));
                    return;
                }

                response.writeHead(200).end(page("Authorized", "You can close this tab and return to your editor."));
                finish(undefined, code);
            });

            server.on("error", (error: NodeJS.ErrnoException) => {
                finish(
                    new OAuthError(
                        error.code === "EADDRINUSE"
                            ? `Port ${this.options.redirectPort} is already in use. Change "vscord.app.redirectPort" (and the redirect URI of your Discord application).`
                            : `Could not start the local callback server: ${error.message}`,
                        error.code
                    )
                );
            });

            server.listen(this.options.redirectPort, "127.0.0.1", () => {
                Promise.resolve(this.options.openUrl(authorizeUrl)).catch((error: Error) => finish(error));
            });
        });
    }

    async logout(clientId: string) {
        const tokens = await this.readTokens(clientId);
        await this.options.secrets.delete(TOKENS_KEY);
        if (!tokens) return;

        const clientSecret = await this.options.secrets.get(CLIENT_SECRET_KEY);
        const body = new URLSearchParams({
            client_id: clientId,
            token: tokens.refreshToken ?? tokens.accessToken,
            token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token"
        });
        if (clientSecret) body.set("client_secret", clientSecret);

        await fetch(`${this.apiBase}/oauth2/token/revoke`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        }).catch(() => undefined);
    }

    async forgetClientSecret() {
        await this.options.secrets.delete(CLIENT_SECRET_KEY);
    }
}
