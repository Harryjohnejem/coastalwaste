import axios from 'axios';
import { useAuthStore } from '../stores/useAuthStore';

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000/api',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    config.headers.delete?.('Content-Type');
    delete config.headers['Content-Type'];
  }
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && !String(error.config?.url || '').includes('/login')) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

export default client;
