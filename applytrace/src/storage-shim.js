// window.storage exists only inside Claude artifacts.
// Locally, back it with localStorage so the app persists normally.
if (!window.storage) {
  window.storage = {
    get: async (key) => {
      const value = localStorage.getItem(key);
      return value === null ? null : { key, value, shared: false };
    },
    set: async (key, value) => {
      localStorage.setItem(key, value);
      return { key, value, shared: false };
    },
    delete: async (key) => {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: false };
    },
    list: async (prefix = "") => ({
      keys: Object.keys(localStorage).filter((k) => k.startsWith(prefix)),
      prefix,
      shared: false,
    }),
  };
}
