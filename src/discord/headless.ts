import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SetActivity } from "@xhayper/discord-rpc";
import { DISCORD_API, NotAuthorizedError, type DiscordOAuth } from "./oauth";

const KEEPALIVE_MS = 4 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_RATE_LIMIT_WAIT_MS = 30 * 1000;

export interface DiscordUser {
    id: string;
    username: string;
}

export interface HeadlessOptions {
    oauth: DiscordOAuth;
    sessionFile: string;
    activityName: () => string;
    log: (...message: unknown[]) => void;
    onAuthorizationLost: (error: Error) => void;
    apiBase?: string;
}

interface SharedSession {
    token: string;
    clientId: string;
    owner: number;
}

class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly body: string
    ) {
        super(`Discord API responded with ${status}: ${body.slice(0, 500)}`);
        this.name = "DISCORD_API_ERROR";
    }
}

const toMillis = (value: number | Date | undefined) => (value instanceof Date ? value.getTime() : value);

const prune = <T extends Record<string, unknown>>(object: T): T | undefined => {
    const entries = Object.entries(object).filter(([, value]) => value !== undefined && value !== "");
    return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
};

export class HeadlessPresence {
    clientId: string;
    user: DiscordUser | undefined;
    isConnected = false;

    private lastActivity: SetActivity | undefined;
    private keepAlive: NodeJS.Timeout | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private buttonsSupported = true;

    constructor(
        clientId: string,
        private readonly options: HeadlessOptions
    ) {
        this.clientId = clientId;
    }

    private get apiBase() {
        return this.options.apiBase ?? DISCORD_API;
    }

    async connect(interactive: boolean) {
        if (!this.clientId) throw new NotAuthorizedError('No Discord application id configured ("vscord.app.id")');

        if (!(await this.options.oauth.hasTokens(this.clientId))) {
            if (!interactive) throw new NotAuthorizedError();
            await this.options.oauth.authorize(this.clientId);
        }

        await this.options.oauth.getAccessToken(this.clientId);
        this.isConnected = true;

        if (!this.user) {
            try {
                const me = (await this.request("GET", "/oauth2/@me")) as { user?: DiscordUser } | undefined;
                this.user = me?.user;
            } catch (error) {
                if (error instanceof NotAuthorizedError) {
                    this.isConnected = false;
                    throw error;
                }
                this.options.log("Could not fetch the Discord user:", error);
            }
        }
    }

    async reauthorize() {
        await this.options.oauth.authorize(this.clientId);
        this.user = undefined;
        await this.connect(false);
    }

    setActivity(activity: SetActivity) {
        this.lastActivity = { ...activity };
        this.scheduleKeepAlive(KEEPALIVE_MS);
        return this.enqueue(() => this.push());
    }

    clearActivity(force = false) {
        this.lastActivity = undefined;
        this.stopKeepAlive();
        return this.enqueue(() => this.deleteSession(force));
    }

    async disconnect() {
        await this.clearActivity(true);
        this.isConnected = false;
    }

    async setClientId(clientId: string) {
        if (clientId === this.clientId) return;
        await this.disconnect();
        this.clientId = clientId;
        this.user = undefined;
    }

    async logout() {
        await this.disconnect();
        this.user = undefined;
        await this.options.oauth.logout(this.clientId);
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private scheduleKeepAlive(delay: number) {
        this.stopKeepAlive();
        this.keepAlive = setTimeout(() => {
            if (!this.lastActivity || !this.isConnected) return;
            if (this.ownedByOtherWindow(this.readSession())) return this.scheduleKeepAlive(KEEPALIVE_MS);
            void this.enqueue(() => this.push());
            this.scheduleKeepAlive(KEEPALIVE_MS);
        }, delay);
        this.keepAlive.unref?.();
    }

    private stopKeepAlive() {
        if (this.keepAlive) clearTimeout(this.keepAlive);
        this.keepAlive = undefined;
    }

    private async push() {
        const activity = this.lastActivity;
        if (!activity || !this.isConnected) return;

        try {
            const token = await this.postSession(activity, this.readSession()?.token);
            if (token) this.writeSession({ token, clientId: this.clientId, owner: process.pid });
        } catch (error) {
            if (error instanceof NotAuthorizedError) {
                this.isConnected = false;
                this.stopKeepAlive();
                this.options.onAuthorizationLost(error);
                return;
            }
            this.options.log("Failed to update the Discord presence, retrying shortly:", error);
            this.scheduleKeepAlive(RETRY_MS);
        }
    }

    private async postSession(activity: SetActivity, token: string | undefined): Promise<string | undefined> {
        const send = async (sessionToken: string | undefined) => {
            const body: Record<string, unknown> = { activities: [this.buildActivity(activity)] };
            if (sessionToken) body.token = sessionToken;
            const response = (await this.request("POST", "/users/@me/headless-sessions", body)) as
                { token?: string } | undefined;
            return response?.token ?? sessionToken;
        };

        try {
            return await send(token);
        } catch (error) {
            if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) throw error;

            if (token) {
                try {
                    return await send(undefined);
                } catch (retryError) {
                    if (!(retryError instanceof ApiError) || retryError.status !== 400) throw retryError;
                    error = retryError;
                }
            }

            if (!this.buttonsSupported || !activity.buttons?.length) throw error;
            this.options.log("Discord rejected the presence, retrying without buttons:", error);
            this.buttonsSupported = false;
            return send(undefined);
        }
    }

    private buildActivity(activity: SetActivity) {
        const start = toMillis(activity.startTimestamp);
        const end = toMillis(activity.endTimestamp);
        const buttons = this.buttonsSupported ? (activity.buttons ?? []).slice(0, 2) : [];

        return prune({
            name: activity.name ?? this.options.activityName(),
            type: activity.type ?? 0,
            application_id: this.clientId,
            platform: "desktop",
            url: activity.url,
            details: activity.details,
            details_url: activity.detailsUrl,
            state: activity.state,
            state_url: activity.stateUrl,
            status_display_type: activity.statusDisplayType,
            timestamps: prune({ start, end }),
            assets: prune({
                large_image: activity.largeImageKey,
                large_text: activity.largeImageText,
                large_url: activity.largeImageUrl,
                small_image: activity.smallImageKey,
                small_text: activity.smallImageText,
                small_url: activity.smallImageUrl
            }),
            buttons: buttons.length > 0 ? buttons.map((button) => button.label) : undefined,
            metadata: buttons.length > 0 ? { button_urls: buttons.map((button) => button.url) } : undefined
        });
    }

    private async deleteSession(force: boolean) {
        const session = this.readSession();
        if (!session) return;
        if (!force && this.ownedByOtherWindow(session)) return;

        this.removeSessionFile();
        try {
            await this.request("POST", "/users/@me/headless-sessions/delete", { token: session.token });
        } catch (error) {
            if (error instanceof ApiError && (error.status === 400 || error.status === 404)) return;
            this.options.log("Failed to clear the Discord presence (it expires on its own within 20 minutes):", error);
        }
    }

    private async request(
        method: "GET" | "POST",
        path: string,
        body?: unknown,
        attempt = 0,
        forceRefresh = false
    ): Promise<unknown> {
        const accessToken = await this.options.oauth.getAccessToken(this.clientId, forceRefresh);

        const response = await fetch(`${this.apiBase}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (response.status === 401) {
            if (forceRefresh) throw new NotAuthorizedError("Discord rejected the stored authorization");
            return this.request(method, path, body, attempt, true);
        }

        if (response.status === 429 && attempt < 2) {
            const header = Number(
                response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset-after")
            );
            const wait = Math.min(Number.isFinite(header) && header > 0 ? header * 1000 : 2000, MAX_RATE_LIMIT_WAIT_MS);
            await new Promise((resolve) => setTimeout(resolve, wait));
            return this.request(method, path, body, attempt + 1, forceRefresh);
        }

        const text = await response.text();
        if (!response.ok) throw new ApiError(response.status, text);
        if (!text) return undefined;
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }

    private ownedByOtherWindow(session: SharedSession | undefined) {
        if (!session || session.owner === process.pid) return false;
        try {
            process.kill(session.owner, 0);
            return true;
        } catch {
            return false;
        }
    }

    private readSession(): SharedSession | undefined {
        try {
            const session = JSON.parse(readFileSync(this.options.sessionFile, "utf8")) as SharedSession;
            return session.token && session.clientId === this.clientId ? session : undefined;
        } catch {
            return undefined;
        }
    }

    private writeSession(session: SharedSession) {
        try {
            mkdirSync(dirname(this.options.sessionFile), { recursive: true });
            writeFileSync(this.options.sessionFile, JSON.stringify(session));
        } catch (error) {
            this.options.log("Could not persist the Discord session:", error);
        }
    }

    private removeSessionFile() {
        try {
            rmSync(this.options.sessionFile, { force: true });
        } catch {}
    }
}
