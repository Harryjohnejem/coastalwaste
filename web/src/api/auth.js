import client from './client';

/** POST /login → { token, user } */
export async function login(email, password) {
  const { data } = await client.post('/login', { email, password }, { timeout: 6000 });
  return data;
}
