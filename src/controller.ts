import {
    type Disposable,
    type ExtensionContext,
    type WindowState,
    Uri,
    commands,
    debug,
    env,
    languages,
    window,
    workspace
} from "vscode";
import type { SetActivity } from "@xhayper/discord-rpc";
import type { GatewayActivityButton } from "discord-api-types/v10";
import { join } from "node:path";
import { getActivityName, getApplicationId, getRedirectPort } from "./helpers/getApplicationId";
import { DiscordOAuth, NotAuthorizedError } from "./discord/oauth";
import { activity, onDiagnosticsChange } from "./activity";
import { HeadlessPresence } from "./discord/headless";
import { StatusBarMode, editor } from "./editor";
import { validURL } from "./helpers/validURL";
import { throttle } from "./helpers/throttle";
import { logError, logInfo, outputChannel } from "./logger";
import { CONFIG_KEYS } from "./constants";
import { getConfig } from "./config";
import { dataClass } from "./data";

export class RPCController {
    listeners: Disposable[] = [];
    enabled = true;
    canSendActivity = true;
    manualIdleMode = false;
    manualIdling = false;
    state: SetActivity = {};
    debug = false;
    client: HeadlessPresence;

    private oauth: DiscordOAuth;
    private idleTimeout: NodeJS.Timeout | undefined;
    private iconTimeout: NodeJS.Timeout | undefined;
    private activityThrottle = throttle(
        (isViewing?: boolean, isIdling?: boolean) => this.sendActivity(isViewing, isIdling),
        2000,
        true
    );

    constructor(ctx: ExtensionContext, debug = false) {
        const config = getConfig();
        this.debug = debug;
        this.manualIdleMode = config.get(CONFIG_KEYS.Status.Idle.Check) === false;

        this.oauth = new DiscordOAuth({
            secrets: ctx.secrets,
            redirectPort: getRedirectPort(config),
            openUrl: (url) => env.openExternal(Uri.parse(url)),
            askClientSecret: () =>
                window.showInputBox({
                    title: "Discord client secret",
                    prompt: 'Discord rejected the login without a client secret. Either enable "Public Client" for your application or paste its client secret here (stored in the VS Code secret storage).',
                    password: true,
                    ignoreFocusOut: true
                })
        });

        this.client = new HeadlessPresence(getApplicationId(config).clientId, {
            oauth: this.oauth,
            sessionFile: join(ctx.globalStorageUri.fsPath, "session.json"),
            activityName: () => getActivityName(getConfig()),
            log: (...message) => {
                if (this.debug) logInfo("[003] Debug:", ...message);
                else logError(...message);
            },
            onAuthorizationLost: (error) => this.onConnectFailed(error)
        });

        editor.setStatusBarItem(StatusBarMode.Pending);

        this.client
            .connect(false)
            .then(() => this.onReady())
            .catch((error: Error) => this.onConnectFailed(error));
    }

    private onReady() {
        logInfo(`Successfully connected to Discord${this.client.user ? ` as ${this.client.user.username}` : ""}`);
        this.cleanUp();

        if (this.enabled) void this.enable(false);
        editor.setStatusBarItem(StatusBarMode.Succeeded);
    }

    private onConnectFailed(error: Error) {
        logError("Encountered following error while trying to connect:", error);
        this.cleanUp();
        editor.setStatusBarItem(StatusBarMode.Disconnected);

        const config = getConfig();
        if (!config.get(CONFIG_KEYS.Enable) || config.get(CONFIG_KEYS.Behaviour.SuppressNotifications)) return;

        if (!this.client.clientId) {
            void window
                .showWarningMessage(
                    'Better VSCord: set "vscord.app.id" to the application id of your own Discord application.',
                    "Open Settings"
                )
                .then((selection) => {
                    if (selection) void commands.executeCommand("workbench.action.openSettings", "vscord.app");
                });
            return;
        }

        const notAuthorized = error instanceof NotAuthorizedError;
        void window
            .showWarningMessage(
                notAuthorized
                    ? "Better VSCord is not authorized with Discord yet."
                    : `Better VSCord could not connect to Discord: ${error.message}`,
                notAuthorized ? "Authorize" : "Retry",
                "Show output"
            )
            .then((selection) => {
                if (selection === "Show output") outputChannel.show(true);
                else if (selection) void commands.executeCommand("vscord.reconnect");
            });
    }
    private listen() {
        const config = getConfig();

        const fileSwitch = window.onDidChangeActiveTextEditor((e) => {
            logInfo("onDidChangeActiveTextEditor()");
            if (e) {
                this.activityThrottle.reset();
                void this.activityThrottle.callable();
                return;
            }
            setTimeout(() => {
                this.checkIdle(window.state);
            }, 500);
        });
        const fileEdit = workspace.onDidChangeTextDocument((e) => {
            if (e.document !== dataClass.editor?.document) return;
            logInfo("onDidChangeTextDocument()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const fileSelectionChanged = window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor !== dataClass.editor) return;
            logInfo("onDidChangeTextEditorSelection()");
            this.activityThrottle.reset();
            void this.activityThrottle.callable();
        });
        const debugStart = debug.onDidStartDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const debugEnd = debug.onDidTerminateDebugSession(() => {
            void this.activityThrottle.callable();
        });
        const diagnosticsChange = languages.onDidChangeDiagnostics(() => onDiagnosticsChange());
        const changeWindowState = window.onDidChangeWindowState((e: WindowState) => {
            logInfo("onDidChangeWindowState()");
            this.checkIdle(e);
        });

        // fire checkIdle at least once after loading
        this.checkIdle(window.state);

        if (config.get(CONFIG_KEYS.Status.Problems.Enabled)) this.listeners.push(diagnosticsChange);
        if (config.get(CONFIG_KEYS.Status.Idle.Check)) this.listeners.push(changeWindowState);

        const windowFocus = window.onDidChangeWindowState((e: WindowState) => {
            if (e.focused) void this.activityThrottle.callable();
        });

        this.listeners.push(fileSwitch, fileEdit, fileSelectionChanged, debugStart, debugEnd, windowFocus);
    }

    private checkCanSend(isIdling: boolean): boolean {
        const config = getConfig();
        if (!this.client.isConnected) return (this.canSendActivity = false);
        if (isIdling && config.get(CONFIG_KEYS.Status.Idle.DisconnectOnIdle)) return (this.canSendActivity = false);
        let whitelistEnabled = config.get(CONFIG_KEYS.App.WhitelistEnabled);
        if (whitelistEnabled) {
            let userId = this.client.user?.id;
            if (!userId) return (this.canSendActivity = false);
            let whitelist = config.get(CONFIG_KEYS.App.Whitelist);
            if (config.get(CONFIG_KEYS.App.whitelistIsBlacklist))
                if (whitelist!.includes(userId)) return (this.canSendActivity = false);
                else return (this.canSendActivity = true);
            else if (!whitelist!.includes(userId)) return (this.canSendActivity = false);
        }
        return (this.canSendActivity = true);
    }

    private checkIdle(windowState: WindowState) {
        if (!this.enabled) return;

        const config = getConfig();

        if (config.get(CONFIG_KEYS.Status.Idle.Timeout) !== 0) {
            if (windowState.focused && this.idleTimeout) {
                clearTimeout(this.idleTimeout);
                void this.activityThrottle.callable();
            } else if (config.get(CONFIG_KEYS.Status.Idle.Check)) {
                this.idleTimeout = setTimeout(
                    async () => {
                        if (!config.get(CONFIG_KEYS.Status.Idle.Check)) return;

                        if (
                            config.get(CONFIG_KEYS.Status.Idle.DisconnectOnIdle) &&
                            config.get(CONFIG_KEYS.Status.Idle.ResetElapsedTime)
                        ) {
                            delete this.state.startTimestamp;
                        }

                        if (!this.enabled) return;

                        void this.activityThrottle.callable(false, true);
                    },
                    config.get(CONFIG_KEYS.Status.Idle.Timeout)! * 1000
                );
            }
        }
    }

    async login(interactive = true) {
        const config = getConfig();
        const { clientId } = getApplicationId(config);
        this.oauth.redirectPort = getRedirectPort(config);
        if (this.debug) logInfo("[004] Debug:", `Logging in with client ID "${clientId}"`);

        if (this.client.clientId !== clientId) await this.client.setClientId(clientId);
        if (this.client.isConnected) return;

        editor.setStatusBarItem(StatusBarMode.Pending);
        await this.client.connect(interactive);
        logInfo(`Successfully connected to Discord${this.client.user ? ` as ${this.client.user.username}` : ""}`);
    }

    async authorize() {
        const config = getConfig();
        this.oauth.redirectPort = getRedirectPort(config);
        await this.client.setClientId(getApplicationId(config).clientId);
        editor.setStatusBarItem(StatusBarMode.Pending);
        await this.client.reauthorize();
    }

    async logout() {
        this.enabled = false;
        this.cleanUp();
        await this.client.logout();
        await this.oauth.forgetClientSecret();
    }

    async sendActivity(isViewing = false, isIdling = false): Promise<void> {
        if (!this.enabled || !this.client.isConnected) return;
        if (this.manualIdleMode) isIdling = this.manualIdling;
        this.checkCanSend(isIdling);
        this.state = await activity(this.state, isViewing, isIdling);
        this.state.instance = true;
        if (!this.state || Object.keys(this.state).length === 0 || !this.canSendActivity)
            return this.client.clearActivity();
        const filteredButton: GatewayActivityButton[] = [];
        this.state.buttons = (this.state.buttons ?? []).filter((button) => {
            const isValid = validURL(button.url);
            if (!isValid) filteredButton.push(button);
            return isValid;
        });

        if (filteredButton.length > 0)
            logInfo(
                "[005]",
                "Invalid buttons!\n",
                filteredButton.map((button) => JSON.stringify(button, null, 2)).join("\n")
            );

        return this.client.setActivity(this.state);
    }

    async disable(clearSharedSession = true) {
        this.enabled = false;

        this.cleanUp();
        if (this.idleTimeout) clearTimeout(this.idleTimeout);
        if (this.iconTimeout) clearTimeout(this.iconTimeout);

        await this.client.clearActivity(clearSharedSession);
    }

    async enable(interactive = true) {
        this.enabled = true;

        try {
            await this.login(interactive);
        } catch (error) {
            this.onConnectFailed(error as Error);
            return;
        }

        editor.setStatusBarItem(StatusBarMode.Succeeded);

        await this.activityThrottle.callable();
        this.cleanUp();
        this.listen();

        if (this.iconTimeout) clearTimeout(this.iconTimeout);
    }

    cleanUp() {
        for (const listener of this.listeners) listener.dispose();
        this.listeners = [];
    }

    async destroy() {
        await this.disable();
        await this.client.disconnect();
    }

    async shutdown() {
        await this.disable(false);
    }
}
