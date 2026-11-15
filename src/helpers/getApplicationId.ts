import { env } from "vscode";
import type { ExtensionConfiguration } from "../config";
import { CONFIG_KEYS } from "../constants";

export const DEFAULT_REDIRECT_PORT = 53682;

export const getApplicationId = (config: ExtensionConfiguration) => {
    const clientId = (config.get(CONFIG_KEYS.App.Id) ?? "").trim();
    return { clientId: /^\d{15,25}$/.test(clientId) ? clientId : "" };
};

export const getActivityName = (config: ExtensionConfiguration) => {
    const name = config.get(CONFIG_KEYS.App.Name);
    return !name || name === "Custom" ? env.appName : name;
};

export const getRedirectPort = (config: ExtensionConfiguration) => {
    const port = config.get(CONFIG_KEYS.App.RedirectPort);
    return typeof port === "number" && port > 0 && port < 65536 ? port : DEFAULT_REDIRECT_PORT;
};
