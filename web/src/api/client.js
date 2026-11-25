import axios, { CanceledError } from 'axios';
import { useAuthStore } from '../stores/useAuthStore';

function resolveApiBase() {
  const configured = String(import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  // Same-origin Vite proxy. Skips the CORS preflight that otherwise doubles
  // every call on the single-threaded `php artisan serve` worker.
  if (import.meta.env.DEV && /^https?:\/\/(127\.0\.0\.1|localhost):8000\/api$/i.test(configured)) {
    return '/api';
  }
  return configured;
}

const client = axios.create({
  baseURL: resolveApiBase(),
  timeout: 25000,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

// Windows `php artisan serve` handles one request at a time. Extra calls sit
// in the browser until Axios aborts them. Hold them here so the timeout
// starts only once a slot is free.
const MAX_CONCURRENT = 1;
let activeRequests = 0;
const requestQueue = [];

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = requestQueue.shift();
  next?.();
}

function takeSlot(config) {
  return new Promise((resolve, reject) => {
    const start = () => {
      config.signal?.removeEventListener('abort', onAbort);
      if (config.signal?.aborted) {
        reject(new CanceledError());
        const queued = requestQueue.shift();
        queued?.();
        return;
      }
      activeRequests += 1;
      resolve();
    };
    const onAbort = () => {
      const index = requestQueue.indexOf(start);
      if (index < 0) return;
      requestQueue.splice(index, 1);
      reject(new CanceledError());
    };
    if (config.signal?.aborted) {
      reject(new CanceledError());
      return;
    }
    config.signal?.addEventListener('abort', onAbort);
    if (activeRequests < MAX_CONCURRENT) start();
    else if (config.priority === 'high') requestQueue.unshift(start);
    else requestQueue.push(start);
  });
}

client.interceptors.request.use(async (config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    config.headers.delete?.('Content-Type');
    delete config.headers['Content-Type'];
  }
  await takeSlot(config);
  config.__apiSlot = true;
  return config;
});

client.interceptors.response.use(
  (res) => {
    if (res.config?.__apiSlot) releaseSlot();
    return res;
  },
  (error) => {
    if (error.config?.__apiSlot) releaseSlot();
    const url = String(error.config?.url || '');
    if (error.response?.status === 401 && !url.includes('/login')) {
      const current = useAuthStore.getState().token;
      const sent = String(error.config?.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
      // Drop only the rejected token. A late 401 must not wipe a fresh login.
      if (current && sent && sent === current) {
        useAuthStore.getState().logout();
      }
    }
    return Promise.reject(error);
  },
);

export default client;
