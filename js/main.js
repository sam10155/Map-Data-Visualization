// --- Cross-browser persistent storage wrapper (Chrome/Edge/Brave) ---
async function createStorageWrapper() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    console.warn("⚠ Persistent storage API not supported — storage disabled");
    return null;
  }

  try {
    const root = await navigator.storage.getDirectory();

    return {
      async set(key, value) {
        const fileHandle = await root.getFileHandle(key, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(value);
        await writable.close();
      },

      async get(key) {
        try {
          const fileHandle = await root.getFileHandle(key);
          const file = await fileHandle.getFile();
          return { value: await file.text() };
        } catch (e) {
          return null;
        }
      },

      async list(prefix = "") {
        const keys = [];
        for await (const [name] of root.entries()) {
          if (name.startsWith(prefix)) keys.push(name);
        }
        return { keys };
      },

      async delete(key) {
        try {
            await root.removeEntry(key);
        } catch (err) {
            console.warn("Failed to delete key:", key, err);
        }
      }
    };
  } catch (err) {
    console.error("Failed to create storage wrapper:", err);
    return null;
  }
}

async function ensurePersistentStorage() {
  if (!window.storage) {
    window.storage = await createStorageWrapper();
  }

  if (window.storage) {
    console.log("[+] Persistent storage initialized");
  } else {
    console.warn("[x] Persistent storage NOT available");
  }
}


// --- MAIN LOAD SEQUENCE ---
window.addEventListener('load', async () => {

  await ensurePersistentStorage();

  if (typeof initPositionCache === 'function') {
    await initPositionCache();  
  }

  initMap();

  if (window.MapModes) {
    MapModes.buildUI();
  }

  setTimeout(() => {
    buildSearchIndex();
    attachSearchUI();
    attachAggregationEvents();
  }, 1000);
});
