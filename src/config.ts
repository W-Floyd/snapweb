// VITE_APP_SNAPSERVER_HOST="" disables the default (e.g. GH Pages build).
// Undefined (not set) falls back to window.location.host for self-hosted use.
const envHost = import.meta.env.VITE_APP_SNAPSERVER_HOST;
const host = envHost !== undefined ? envHost : window.location.host;

const keys = {
  snapserver_host: "snapserver.host",
  theme: "theme",
  showoffline: "showoffline",
  autoPlay: "autoPlay",
  localOffsetMs: "localOffsetMs",
}

enum Theme {
  System = "system",
  Light = "light",
  Dark = "dark",
}

function setPersistentValue(key: string, value: string) {
  if (window.localStorage) {
    window.localStorage.setItem(key, value);
  }
}

function getPersistentValue(key: string, defaultValue: string = ""): string {
  if (window.localStorage) {
    const value = window.localStorage.getItem(key);
    if (value !== null) {
      return value;
    }
    window.localStorage.setItem(key, defaultValue);
    return defaultValue;
  }
  return defaultValue;
}

// ?host=ws://192.168.1.1:1780 persists the server URL on first load.
const hostParam = new URLSearchParams(window.location.search).get('host');
if (hostParam) setPersistentValue(keys.snapserver_host, hostParam);

const config = {
  get baseUrl() {
    const defaultUrl = host ? (window.location.protocol === "https:" ? "wss://" : "ws://") + host : "";
    return getPersistentValue(keys.snapserver_host, defaultUrl);
  },
  set baseUrl(value) {
    setPersistentValue(keys.snapserver_host, value);
  },
  get theme() {
    return getPersistentValue(keys.theme, Theme.System.toString()) as Theme;
  },
  set theme(value: Theme) {
    setPersistentValue(keys.theme, value);
  },
  get showOffline() {
    return getPersistentValue(keys.showoffline, String(false)) === String(true);
  },
  set showOffline(value: boolean) {
    setPersistentValue(keys.showoffline, String(value));
  },
  get autoPlay() {
    return getPersistentValue(keys.autoPlay, String(false)) === String(true);
  },
  set autoPlay(value: boolean) {
    setPersistentValue(keys.autoPlay, String(value));
  },
  get localOffsetMs() {
    return parseFloat(getPersistentValue(keys.localOffsetMs, "0")) || 0;
  },
  set localOffsetMs(value: number) {
    setPersistentValue(keys.localOffsetMs, String(value));
  },
};


export { config, getPersistentValue, setPersistentValue, Theme };
