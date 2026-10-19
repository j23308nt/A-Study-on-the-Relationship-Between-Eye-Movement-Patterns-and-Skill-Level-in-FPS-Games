function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('eye-tracking-shooting', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recovery');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function recovery(action, value) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('recovery', action === 'get' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('recovery');
      const request = action === 'get' ? store.get('latest') : action === 'delete' ? store.delete('latest') : store.put(value, 'latest');
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || Error('一時保存が中断されました。'));
    });
  } finally { db.close(); }
}
