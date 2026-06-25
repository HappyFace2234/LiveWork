import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import {
  normalizeSettings,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
  type AppSettings,
} from "@/lib/settings";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
  redactSettingsForWebStorage,
  type GatewaySettingsSyncPayload,
} from "@/lib/settings/sync";
import { loadToken } from "@/lib/storage";
import { loadWebSettings, persistWebSettings, type WebSettingsSaveState } from "@/lib/webSettings";
import { setPreferredMonacoNlsLocale } from "@/lib/monacoNls";

import { asErrorMessage } from "../chatEventUtils";
import {
  hasSettingsSyncChanged,
  resolveAppWorkspaceProjects,
} from "../historyUtils";

export function useGatewaySettingsSync(params: {
  token: string;
  api: GatewayWebSocketClientLike | null;
}) {
  const { token, api } = params;
  const [settings, setSettingsState] = useState<AppSettings>(() => loadWebSettings(loadToken()));
  const [settingsSyncReady, setSettingsSyncReady] = useState(() => token.trim() === "");
  const [settingsSyncError, setSettingsSyncError] = useState<string | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<WebSettingsSaveState>({
    status: "saved",
  });
  const settingsSaveSequenceRef = useRef(0);
  const settingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);

  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveEffectiveTheme(settings.theme) === "dark");
  }, [settings.theme, systemThemeVersion]);

  useEffect(() => {
    setSettingsState((prev) =>
      resolveAppWorkspaceProjects(
        normalizeSettings({
          ...prev,
          remote: {
            ...prev.remote,
            gatewayUrl: window.location.origin,
            token: token.trim(),
            enabled: token.trim() !== "" || prev.remote.enabled,
          },
        }),
      ),
    );
  }, [token]);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, syncGateway: boolean) => {
      const saveSequence = ++settingsSaveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });
      const redactedNext = redactSettingsForWebStorage(next);
      const gatewayUpdate =
        syncGateway && api
          ? buildGatewaySettingsSyncUpdatePayload(prev, next, {
              includeProviderApiKeyUpdates: true,
            })
          : null;

      settingsSaveChainRef.current = settingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => {
          persistWebSettings(redactedNext);
        })
        .then(async () => {
          if (gatewayUpdate && Object.keys(gatewayUpdate).length > 0) {
            await api?.updateSettings(gatewayUpdate);
          }
        })
        .then(() => {
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (syncGateway && api) {
            void api
              .getSettings()
              .then((payload) => {
                setSettingsState((current) => {
                  const refreshed = redactSettingsForWebStorage(
                    resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(current, payload)),
                  );
                  persistWebSettings(refreshed);
                  return refreshed;
                });
              })
              .catch(() => undefined);
          }
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: asErrorMessage(error, fallback),
            });
          }
        });
    },
    [api],
  );

  const applyGatewaySettings = useCallback(
    (payload: GatewaySettingsSyncPayload) => {
      setSettingsState((prev) => {
        const rawNext = resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(prev, payload));
        const next = redactSettingsForWebStorage(rawNext);
        if (!hasSettingsSyncChanged(prev, next)) {
          return prev;
        }
        queueSettingsSave(prev, next, "同步桌面端设置失败。", false);
        return next;
      });
    },
    [queueSettingsSave],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      setSettingsState((prev) => {
        const updated = updater(prev);
        if (updated === prev) return prev;
        const rawNext = resolveAppWorkspaceProjects(normalizeSettings(updated));
        const next = redactSettingsForWebStorage(rawNext);
        queueSettingsSave(prev, rawNext, "保存 WebUI 设置失败。", true);
        return next;
      });
    },
    [queueSettingsSave],
  );

  useEffect(() => {
    if (!api) {
      setSettingsSyncReady(token.trim() === "");
      setSettingsSyncError(null);
      return;
    }

    let cancelled = false;
    setSettingsSyncReady(false);
    setSettingsSyncError(null);
    const unsubscribe = api.subscribeSettings((payload) => {
      if (cancelled) {
        return;
      }
      applyGatewaySettings(payload);
      setSettingsSyncError(null);
    });

    void api
      .getSettings()
      .then((payload) => {
        if (!cancelled) {
          applyGatewaySettings(payload);
          setSettingsSyncReady(true);
          setSettingsSyncError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsSyncError(asErrorMessage(error, "同步桌面端设置失败"));
          setSettingsSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyGatewaySettings, token]);

  return {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncError,
    settingsSaveState,
  };
}
